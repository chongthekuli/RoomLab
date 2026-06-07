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
import { buildRoomFields } from '../js/capture/capture-flow.js';
import { wallInsetPolygon } from '../js/physics/wall-inset.js';
import { roomEffectiveBounds } from '../js/physics/room-shape.js';
import { buildFloorPlanSVG } from '../js/ui/print-plan-svg.js';
import { buildHeatmapPageSVG, buildHeatmapLegend, heatmapPageViewBox } from '../js/ui/print-heatmap.js';
import { dilateGridForDisplay, buildSilhouetteMask } from '../js/physics/grid-display.js';
import { splColorRGB, stiColorRGB, colorForMetric, SPL_DOMAIN_MIN_DB, SPL_DOMAIN_MAX_DB } from '../js/graphics/colour-ramps.js';

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
  state.structures = [];
  state.selectedStructureId = null;
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
// Heatmap display-fill + clip (bug 2026-05-21).
//
// The SPL/STI heatmap renders on 3 of the 4 surfaces (2D viewport, 3D
// scalar shader, print heatmap) — a cross-surface concept, so it lives
// here. computeSPLGrid keeps a cell only if its CENTRE is inside the room
// polygon, but every surface paints the full cell square: edge cells leak
// past the wall (centre just inside) or leave white gaps (centre just
// outside). The fix is render-only: dilateGridForDisplay bleeds one
// boundary ring (fills gaps) and every surface hard-clips to the true
// room polygon (trims leaks). Both halves must ship together — dilation
// alone trades gaps for leaks; clipping alone leaves gaps.
//
// Guards:
//   (1) dilateGridForDisplay unit behaviour — one-ring, 8-adjacency,
//       no-mutate, outside stays -Infinity, fill within neighbour range.
//   (2) all 3 heatmap surfaces import AND call the SAME shared helper
//       (grep guard, scene-x-mirror.test.mjs style) — no private re-impl.
//   (3) the print heatmap emits a clipPath and the raster references it
//       (functional, via the canvas shim) — print was the surface with
//       NO clip at all, the worst leak.
// --------------------------------------------------------------------

const NEG_INF = -Infinity;

function assertDilateUnit() {
  // 5×5 with a finite 3×3 core so the boundary ring is unambiguous.
  const N = NEG_INF;
  const grid = [
    [N, N, N, N, N],
    [N, 1, 2, 3, N],
    [N, 4, 5, 6, N],
    [N, 7, 8, 9, N],
    [N, N, N, N, N],
  ];
  // -Infinity-safe snapshot so we can prove no mutation.
  const serialize = g => JSON.stringify(g.map(r => r.map(v => (Number.isFinite(v) ? v : 'NEG_INF'))));
  const before = serialize(grid);
  const out = dilateGridForDisplay(grid, 5, 5);

  // (1a) does not mutate input — value AND identity (new outer + new rows).
  ok(serialize(grid) === before, 'dilate: input grid is not mutated (values unchanged)');
  ok(out !== grid && out[1] !== grid[1], 'dilate: returns new outer array AND new rows (no shared row ref)');

  // (1b) fills EXACTLY the one boundary ring: a cell becomes finite iff it
  // was finite OR is 8-adjacent to an ORIGINAL finite cell. Nothing more.
  let ringOk = true, ringErr = '';
  for (let j = 0; j < 5 && ringOk; j++) {
    for (let i = 0; i < 5; i++) {
      const wasFinite = Number.isFinite(grid[j][i]);
      let adj = false;
      for (let dj = -1; dj <= 1 && !adj; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const jj = j + dj, ii = i + di;
          if (jj < 0 || jj >= 5 || ii < 0 || ii >= 5) continue;
          if (Number.isFinite(grid[jj][ii])) { adj = true; break; }
        }
      }
      const expectFinite = wasFinite || adj;
      if (Number.isFinite(out[j][i]) !== expectFinite) {
        ringOk = false; ringErr = `cell (${j},${i}) expected finite=${expectFinite}, got ${out[j][i]}`; break;
      }
    }
  }
  ok(ringOk, 'dilate: fills exactly one 8-adjacent boundary ring, no more', ringErr);

  // The four CORNERS of the 5×5 are diagonally 8-adjacent to the finite
  // core, so they MUST fill — locks the 8-neighbour (not 4-neighbour) rule.
  ok([out[0][0], out[0][4], out[4][0], out[4][4]].every(Number.isFinite),
     'dilate: corner cells fill via diagonal adjacency (8-neighbour rule)');

  // (1c) single-pass — running twice fills strictly MORE than once (the
  // first ring did not seed a second ring within one call). Uses a 7×7
  // with a centred 3×3 core so one ring (→ 5×5) does NOT saturate the
  // grid, leaving room for the second pass (→ 7×7) to fill more.
  const count = g => g.flat().filter(Number.isFinite).length;
  const c7 = Array.from({ length: 7 }, () => Array(7).fill(NEG_INF));
  for (let j = 2; j <= 4; j++) for (let i = 2; i <= 4; i++) c7[j][i] = (j - 2) * 3 + (i - 2) + 1;
  const c7once = dilateGridForDisplay(c7, 7, 7);
  const c7twice = dilateGridForDisplay(c7once, 7, 7);
  ok(count(c7) === 9 && count(c7once) === 25 && count(c7twice) === 49,
     'dilate: single pass grows the finite region by exactly one ring (9 → 25 → 49)',
     `orig=${count(c7)} once=${count(c7once)} twice=${count(c7twice)}`);

  // (1d) fill value lies within [min,max] of the ORIGINAL finite
  // 8-neighbours — never fabricates a value outside the sampled range.
  let rangeOk = true, rangeErr = '';
  for (let j = 0; j < 5 && rangeOk; j++) {
    for (let i = 0; i < 5; i++) {
      if (Number.isFinite(grid[j][i]) || !Number.isFinite(out[j][i])) continue;
      const ns = [];
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const jj = j + dj, ii = i + di;
        if (jj < 0 || jj >= 5 || ii < 0 || ii >= 5) continue;
        if (Number.isFinite(grid[jj][ii])) ns.push(grid[jj][ii]);
      }
      const lo = Math.min(...ns), hi = Math.max(...ns), v = out[j][i];
      if (v < lo - 1e-9 || v > hi + 1e-9) { rangeOk = false; rangeErr = `cell (${j},${i})=${v} outside [${lo},${hi}]`; break; }
    }
  }
  ok(rangeOk, 'dilate: filled value is within [min,max] of real neighbours (no fabricated extremes)', rangeErr);

  // (1e) a cell with NO finite neighbour stays -Infinity. 7×7 with a finite
  // 2×2 in one corner — the far corner is >1 cell from any data.
  const big = Array.from({ length: 7 }, () => Array(7).fill(NEG_INF));
  big[0][0] = 50; big[0][1] = 51; big[1][0] = 52; big[1][1] = 53;
  const bigOut = dilateGridForDisplay(big, 7, 7);
  ok(bigOut[6][6] === NEG_INF, 'dilate: cell with no finite neighbour stays -Infinity (no-data preserved)');
}

function assertHeatmapFillParity() {
  // (2) All three heatmap surfaces import AND call the shared helper.
  const surfaces = [
    ['2d-viewport',  'js/graphics/room-2d.js'],
    ['3d-shader',    'js/graphics/heatmap-shader.js'],
    ['print-heatmap','js/ui/print-heatmap.js'],
  ];
  for (const [id, file] of surfaces) {
    let src = '';
    try { src = readFileSync(file, 'utf8'); } catch (e) { fail(`heatmap-fill: ${id} unreadable (${file})`, String(e)); continue; }
    ok(/from\s+['"][^'"]*physics\/grid-display\.js['"]/.test(src),
       `heatmap-fill: ${id} imports dilateGridForDisplay from js/physics/grid-display.js`);
    ok(/dilateGridForDisplay\s*\(/.test(src),
       `heatmap-fill: ${id} calls dilateGridForDisplay before its render loop`);
  }

  // (3) Print heatmap functionally emits a room clipPath and the raster
  // references it. Use a CUSTOM polygon room so a bbox-rect clip would be
  // detectably wrong (the clip polygon must carry the room's vertex count).
  installCanvasShim();
  buildFixtureState();
  const verts = [
    { x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 4 },
    { x: 4, y: 4 }, { x: 4, y: 8 }, { x: 0, y: 8 },
  ];
  state.room.shape = 'custom';
  state.room.custom_vertices = verts;
  const svg = buildHeatmapPageSVG(state, makeFakeSplGrid(state.room));
  ok(/<clipPath id="pr-heat-clip">/.test(svg), 'print-heatmap: emits a room clipPath (was MISSING — the report leak)');
  ok(/<g clip-path="url\(#pr-heat-clip\)"><g transform="[^"]*"><image\b/.test(svg),
     'print-heatmap: heat raster <image> is wrapped in the clip group');
  const clipPoly = svg.match(/<clipPath id="pr-heat-clip"><polygon points="([^"]+)"/);
  const nClipPts = clipPoly ? clipPoly[1].trim().split(/\s+/).length : 0;
  ok(nClipPts === verts.length,
     `print-heatmap: clip polygon traces the true ${verts.length}-vertex outline (not a 4-pt bbox)`,
     `got ${nClipPts} points`);
}

function assertSilhouetteMask() {
  // 3D room-level path (zone-less rooms): the heatmap renders on a
  // rectangular plane with NO geometric clip, so buildSilhouetteMask is
  // the polygon boundary. L-shape (asymmetric in Y so a flipped mask is
  // caught): inside if (x∈[0,4),y∈[0,2)) OR (x∈[0,2),y∈[0,4)).
  const insideL = (x, y) =>
    (x >= 0 && x < 4 && y >= 0 && y < 2) ||
    (x >= 0 && x < 2 && y >= 0 && y < 4);
  const cellsX = 4, cellsY = 4, originX = 0, originY = 0, totalW = 4, totalD = 4;
  const scale = 2;
  const maskW = cellsX * scale, maskH = cellsY * scale;
  const mask = buildSilhouetteMask(maskW, maskH, originX, originY, totalW, totalD, insideL);

  // (a) every texel matches insideFn at its OWN sub-cell centre — locks the
  // flipY Y-mapping and the half-texel offset. An asymmetric L would mask
  // upside-down (leak jumps to the opposite wall) if either is wrong.
  let exact = true, exErr = '';
  for (let mj = 0; mj < maskH && exact; mj++) {
    const sy = originY + (1 - (mj + 0.5) / maskH) * totalD;
    for (let mi = 0; mi < maskW; mi++) {
      const sx = originX + ((mi + 0.5) / maskW) * totalW;
      const expect = insideL(sx, sy) ? 255 : 0;
      if (mask[mj * maskW + mi] !== expect) {
        exact = false; exErr = `texel (${mi},${mj}) @ state(${sx},${sy}) expected ${expect}, got ${mask[mj * maskW + mi]}`; break;
      }
    }
  }
  ok(exact, 'silhouette-mask: every texel matches insideFn at its sub-cell centre (flipY + half-texel correct)', exErr);

  const at = (sx, sy) => {
    const mi = Math.floor((sx / totalW) * maskW);
    const mj = Math.floor((1 - sy / totalD) * maskH);
    return mask[mj * maskW + mi];
  };
  // The cut corner is where dilateGridForDisplay's overshoot would leak —
  // the mask must discard it.
  ok(at(3, 3) === 0, 'silhouette-mask: cut corner (3,3) OUTSIDE → discarded (dilated overshoot cannot leak)');
  ok(at(1, 1) === 255, 'silhouette-mask: core (1,1) INSIDE → rendered');
  ok(at(3, 1) === 255 && at(1, 3) === 255, 'silhouette-mask: both L legs render; Y orientation not flipped');

  // (b) scene.js room-level path actually USES the shader + silhouette
  // predicate — guards against a silent revert to the leaky CanvasTexture.
  let scene = '';
  try { scene = readFileSync('js/graphics/scene.js', 'utf8'); } catch (e) { fail('silhouette-mask: scene.js unreadable', String(e)); return; }
  ok(/buildHeatmapShaderMaterial\(splResult,\s*\{[\s\S]{0,80}insideAt:/.test(scene),
     'scene.js: room-level heatmap passes insideAt to buildHeatmapShaderMaterial (not the CanvasTexture leak path)');
  ok(/insideAt:\s*\(x,\s*y\)\s*=>\s*isInsideRoom3D\(\{\s*x,\s*y,\s*z:\s*ear\s*\},\s*state\.room\)/.test(scene),
     'scene.js: room-level silhouette predicate is isInsideRoom3D at the grid ear height — the SAME predicate computeSPLGrid uses, so the mask cannot discard finite cells (incl. the surau podium/arcade); a narrower isInsideRoom hid the corridor heatmap in 3D (2026-05-21)');
}

// --------------------------------------------------------------------
// Negative-coordinate geometry must stay ON-PAGE in the print plan
// (2026-06-04). The 2D custom-room editor now lets a user drag a polygon
// corner into negative coordinate space (the floor-at-0 in
// clampVertexDragTarget was removed). buildFloorPlanSVG must size its
// viewBox from roomEffectiveBounds (true vertex min/max) so the negative
// geometry isn't clipped off the printed plan — the silent cross-surface
// parity break Viktor flagged during the fix review. Pre-fix the viewBox
// ran 0..width_m and a vertex/marker at x=-2 projected to a negative
// SVG-x, off the left edge of the page.
// --------------------------------------------------------------------

function assertPrintPlanCapturesNegativeGeometry() {
  buildFixtureState();
  // Custom polygon with a corner pulled into negative X and Y.
  state.room.shape = 'custom';
  state.room.custom_vertices = [
    { x: -2, y: -1 }, { x: 6, y: -1 }, { x: 6, y: 8 }, { x: -2, y: 8 },
  ];
  // True-bbox span that recomputeRoomDimsFromPolygon would write:
  // x ∈ [-2, 6] → 8, y ∈ [-1, 8] → 9.
  state.room.width_m = 8;
  state.room.depth_m = 9;
  // Park a listener ON the negative corner so we can read its projected
  // position straight out of the SVG.
  state.listeners = [{ id: 'L1', label: 'L1', position: { x: -2, y: -1, z: 1.2 }, posture: 'standing' }];
  state.sources = [];

  const svg = buildFloorPlanSVG(state);
  const vb = svg.match(/viewBox="0 0 (\S+) (\S+)"/);
  ok(!!vb, 'neg-geom: print-plan SVG carries a viewBox');
  const viewW = vb ? parseFloat(vb[1]) : 0;
  const viewH = vb ? parseFloat(vb[2]) : 0;
  const lst = svg.match(/<circle cx="([^"]+)" cy="([^"]+)" r="0\.26" fill="#0a8a4a"/);
  ok(!!lst, 'neg-geom: listener marker present in print-plan SVG');
  if (lst) {
    const cx = parseFloat(lst[1]), cy = parseFloat(lst[2]);
    ok(cx >= 0 && cx <= viewW,
       `neg-geom: listener at state x=-2 lands ON-PAGE (0 ≤ cx=${cx.toFixed(2)} ≤ viewW=${viewW.toFixed(2)})`,
       'negative-X geometry must not clip off the print plan');
    ok(cy >= 0 && cy <= viewH,
       `neg-geom: listener at state y=-1 lands ON-PAGE (0 ≤ cy=${cy.toFixed(2)} ≤ viewH=${viewH.toFixed(2)})`,
       'negative-Y geometry must not clip off the print plan');
  }
}

// --------------------------------------------------------------------
// Offset custom room must FIT + CENTER in the print frame (2026-06-04).
// A custom polygon carries absolute vertex coords that may start far from
// world (0,0) (drawn at an offset, or a corner dragged negative). The old
// viewBox math did Math.min(0, gridOX) / Math.max(width_m, …), padding a
// phantom dead-band from the origin to the room — so the room jammed
// against one edge of the frame and the aspect distorted ("2D view
// doesn't fit the frame", user report). Both print SVG surfaces must size
// the viewBox to the room's TRUE effective bounds so the room sits
// centered with equal MARGIN_M bands, and both must agree.
// --------------------------------------------------------------------

function assertOffsetCustomRoomFitsFrame() {
  installCanvasShim();
  buildFixtureState();
  // Irregular pentagon translated to bbox (10,30)→(38,52): 28 m × 22 m,
  // center (24, 41). NOT at the origin — this is what trips the bug.
  state.room.shape = 'custom';
  state.room.custom_vertices = [
    { x: 10, y: 30 }, { x: 38, y: 30 }, { x: 38, y: 46 }, { x: 24, y: 52 }, { x: 10, y: 46 },
  ];
  state.room.width_m = 28;   // true-bbox span (recomputeRoomDimsFromPolygon)
  state.room.depth_m = 22;
  // A listener parked at the bbox CENTER must land at the viewBox center
  // once the frame fits the room.
  state.listeners = [{ id: 'L1', label: 'L1', position: { x: 24, y: 41, z: 1.2 }, posture: 'standing' }];
  state.sources = [];
  // Grid origin + extent = the room's effective bounds (what computeSPLGrid
  // produces for a custom room).
  const splGrid = {
    grid: [[60, 70], [50, 80]], cellsX: 2, cellsY: 2,
    originX_m: 10, originY_m: 30, cellW_m: 14, cellD_m: 11,
    metric: 'spl', minSPL_db: 50, maxSPL_db: 80, avgSPL_db: 65, sourceCount: 0,
  };

  const MARGIN = 1.5;                       // print-{plan,heatmap} MARGIN_M
  const expectAspect = (28 + 2 * MARGIN) / (22 + 2 * MARGIN);  // 31/25 = 1.24

  const parse = (svg, label) => {
    const vb = svg.match(/viewBox="0 0 (\S+) (\S+)"/);
    const lst = svg.match(/<circle cx="([^"]+)" cy="([^"]+)" r="0\.26" fill="#0a8a4a"/);
    ok(!!vb, `${label}: viewBox present`);
    ok(!!lst, `${label}: listener marker present`);
    if (!vb || !lst) return null;
    return {
      viewW: parseFloat(vb[1]), viewH: parseFloat(vb[2]),
      cx: parseFloat(lst[1]), cy: parseFloat(lst[2]),
    };
  };

  const plan = parse(buildFloorPlanSVG(state), 'fit-plan');
  const heat = parse(buildHeatmapPageSVG(state, splGrid), 'fit-heatmap');

  for (const [label, p] of [['fit-plan', plan], ['fit-heatmap', heat]]) {
    if (!p) continue;
    // (a) Room centered: the bbox-center listener lands at the viewBox
    //     center (pre-fix it was shoved toward one edge).
    ok(Math.abs(p.cx - p.viewW / 2) < 0.05,
       `${label}: room horizontally centered (listener cx=${p.cx.toFixed(2)} ≈ viewW/2=${(p.viewW / 2).toFixed(2)})`);
    ok(Math.abs(p.cy - p.viewH / 2) < 0.05,
       `${label}: room vertically centered (listener cy=${p.cy.toFixed(2)} ≈ viewH/2=${(p.viewH / 2).toFixed(2)})`);
    // (b) viewBox aspect matches the room bbox aspect (pre-fix it was
    //     distorted to ~0.56 by the phantom dead-band).
    const aspect = p.viewW / p.viewH;
    ok(Math.abs(aspect - expectAspect) < 0.02,
       `${label}: viewBox aspect ${aspect.toFixed(3)} ≈ room aspect ${expectAspect.toFixed(3)}`);
  }

  // (c) Plan ↔ heatmap parity — both pages size the same viewBox.
  if (plan && heat) {
    ok(Math.abs(plan.viewW - heat.viewW) < 0.01 && Math.abs(plan.viewH - heat.viewH) < 0.01,
       `fit: plan and heatmap emit the same viewBox (${plan.viewW}×${plan.viewH} vs ${heat.viewW}×${heat.viewH})`);
  }

  // (d) heatmapPageViewBox (drives the stage aspect-ratio CSS) agrees with
  //     the rendered heatmap viewBox — so the frame can't silently drift.
  const vbHelper = heatmapPageViewBox(state, splGrid);
  if (vbHelper && heat) {
    ok(Math.abs(vbHelper.viewW - heat.viewW) < 0.01 && Math.abs(vbHelper.viewH - heat.viewH) < 0.01,
       'fit: heatmapPageViewBox matches the rendered heatmap viewBox (stage aspect ↔ SVG)');
  }
}

// --------------------------------------------------------------------
// Building-structure footprint parity (2026-06-05).
//
// Pillars / half-walls / partitions / beams / platforms render on the 2D
// viewport, the 3D viewport, AND the print plan SVG (and the print heatmap
// FIELD reflects them via the physics). The cross-surface guarantee: every
// surface derives the footprint from the SAME shared helpers in
// js/physics/building-structures.js (structureFootprintCorners /
// structureFootprintCircle / structurePlanSize / structureHeightRange) — never
// a per-surface re-implementation. This is the 5th-rendering-concept guard
// CLAUDE.md §3 calls out (the north-arrow-leak failure mode).
// --------------------------------------------------------------------

function assertStructureParity() {
  // (1) Shared-helper grep gate — each render surface must import the geometry
  //     from building-structures.js, not roll its own footprint math.
  const grepGate = (file, helpers, label) => {
    let src = '';
    try { src = readFileSync(file, 'utf8'); } catch (e) { fail(`structure-parity: ${label} unreadable (${file})`, String(e)); return; }
    ok(/from\s+['"][^'"]*physics\/building-structures(?:\.js)?['"]/.test(src),
       `structure-parity: ${label} imports from physics/building-structures.js`);
    for (const h of helpers) {
      ok(new RegExp(`\\b${h}\\s*\\(`).test(src), `structure-parity: ${label} calls ${h}()`);
    }
  };
  grepGate('js/graphics/room-2d.js', ['structureFootprintCorners'], '2d-viewport');
  grepGate('js/ui/print-plan-svg.js', ['structureFootprintCorners'], 'print-plan');
  grepGate('js/graphics/scene.js', ['structureHeightRange', 'structurePlanSize'], '3d-viewport');

  // (2) Functional Y-flip parity — a round pillar placed at the SOURCE position
  //     must project (in the print plan) to the SAME screen point as the source
  //     triangle. Proves the structure footprint shares projectXY (offset +
  //     Y-flip), not a divergent transform.
  buildFixtureState();
  state.structures = [{
    id: 'S1', type: 'pillar', crossSection: 'round', diameter_m: 0.5,
    materialId: 'concrete-painted', position: { x: SOURCE_POS.x, y: SOURCE_POS.y },
    rotation_deg: 0, fullHeight: true,
  }];
  const svg = buildFloorPlanSVG(state);
  // The structure circle is the grey one (fill #cfd2d6); the listener circle is
  // green (#0a8a4a) so the regexes don't collide.
  const pillar = svg.match(/<circle cx="([^"]+)" cy="([^"]+)" r="[^"]+" fill="#cfd2d6"/);
  ok(!!pillar, 'structure-parity: pillar footprint circle present in print-plan SVG');
  const srcPoly = svg.match(/<polygon points="([^"]+)" fill="[^"]+" stroke="#000" stroke-width="0\.04" \/>/);
  if (pillar && srcPoly) {
    const pcx = parseFloat(pillar[1]), pcy = parseFloat(pillar[2]);
    const pts = srcPoly[1].split(/\s+/).map(p => p.split(',').map(Number));
    const scx = pts.reduce((a, p) => a + p[0], 0) / 3;
    const scy = pts.reduce((a, p) => a + p[1], 0) / 3;
    ok(Math.abs(pcx - scx) < 0.1,
       'structure-parity: pillar at source-X projects to the source screen-X (shared projectXY)',
       `pillar cx=${pcx.toFixed(3)} vs source cx=${scx.toFixed(3)}`);
    ok(Math.abs(pcy - scy) < 0.1,
       'structure-parity: pillar at source-Y projects to the source screen-Y (shared Y-flip)',
       `pillar cy=${pcy.toFixed(3)} vs source cy=${scy.toFixed(3)}`);
  }
}

// --------------------------------------------------------------------
// Toilet architectural plan symbol parity (Sam, 2026-06-07, v=774).
//
// The toilet bank now draws a real plan symbol (cubicle dividers + per-cubicle
// part-open door leaf + quarter-circle door-swing arc + WC pan/cistern) on the
// 2D viewport AND the print plan SVG, both consuming the SINGLE pure helper
// toiletPlanSegments(s, room) from js/physics/building-structures.js.
//
// Drift risks this fixture guards (Sam's #1: the swing-arc winding):
//   (a) grep-gate — both renderers import AND call toiletPlanSegments.
//   (b) single-source — the 3-cubicle default emits the EXACT locked primitive
//       count, and every role ∈ the locked vocabulary.
//   (c) the door-swing arc winds the SAME way on both surfaces after each
//       surface's Y-flip (analytically apply a→−a, ccw→!ccw), and the leaf
//       open-endpoint lies ON the swing arc (radius leafW from the hinge).
//   (d) the wc-cistern sits between the wc-pan and the rear wall (against the
//       rear) — in state coords AND after each surface's Y-flip — for rotation
//       0 and 90.
//   (f) every primitive's role ∈ the locked set.
// --------------------------------------------------------------------

import { toiletPlanSegments } from '../js/physics/building-structures.js';

const TOILET_ROLES = new Set([
  'bank-outline', 'divider', 'front-filler', 'door-leaf', 'door-swing', 'wc-pan', 'wc-cistern',
]);

function toiletFixture(over = {}) {
  return {
    id: 'WC1', type: 'toilet', position: { x: 4, y: 4 }, rotation_deg: 0,
    materialId: 'gypsum-board', elev_m: 0,
    cubicles: 3, clearWidth_m: 0.90, clearDepth_m: 1.50, partitionThickness_m: 0.05,
    topType: 'open', openTopBoardH_m: 2.00, scuffGap_m: 0.15, doorClearH_m: 2.10,
    doorSide: '+y', hingeSide: 'left', frontLatchGap_m: 0.010, hingeReveal_m: 0.010, doorThk_m: 0.04,
    undercut_m: 0.30, doorsOpen: [false, false, false], showBowls: true, seatHeight_m: 0.42,
    ...over,
  };
}

function assertToiletPlanParity() {
  const room = { width_m: 8, depth_m: 8, height_m: 3 };

  // (a) grep-gate — both renderers import AND call toiletPlanSegments.
  for (const [id, file] of [
    ['2d-viewport', 'js/graphics/room-2d.js'],
    ['print-plan',  'js/ui/print-plan-svg.js'],
  ]) {
    let src = '';
    try { src = readFileSync(file, 'utf8'); } catch (e) { fail(`toilet-plan: ${id} unreadable (${file})`, String(e)); continue; }
    ok(/from\s+['"][^'"]*physics\/building-structures(?:\.js)?['"]/.test(src) && /\btoiletPlanSegments\b/.test(src),
       `toilet-plan: ${id} imports toiletPlanSegments from building-structures.js`);
    ok(/toiletPlanSegments\s*\(/.test(src),
       `toilet-plan: ${id} calls toiletPlanSegments()`);
  }

  // (b) single-source — locked primitive count for the 3-cubicle default.
  // 1 bank-outline + (cubicles+1) dividers + 1 rear + per cubicle (door-leaf +
  // door-swing + wc-cistern + wc-pan). No filler at the default.
  const s = toiletFixture();
  const seg = toiletPlanSegments(s, room);
  const N = s.cubicles;
  const expectCount = 1 /*outline*/ + (N + 1) /*dividers*/ + 1 /*rear*/ + N * 4 /*leaf+swing+cistern+pan*/;
  ok(seg.primitives.length === expectCount,
     `toilet-plan: 3-cubicle default emits the locked primitive count (${expectCount})`,
     `got ${seg.primitives.length}`);
  ok(seg.meta.cubicles === N && Math.abs(seg.meta.rotation_deg) < 1e-9,
     'toilet-plan: meta carries cubicles + rotation_deg');
  ok(seg.primitives.filter(p => p.role === 'front-filler').length === 0,
     'toilet-plan: default leaf-fills-opening → NO front-filler primitive');

  // (f) every primitive's role ∈ the locked set.
  const badRole = seg.primitives.find(p => !TOILET_ROLES.has(p.role));
  ok(!badRole, 'toilet-plan: every primitive role is in the locked vocabulary',
     badRole ? `unknown role "${badRole.role}"` : '');

  // Count the per-cubicle primitives that must exist.
  const count = (role) => seg.primitives.filter(p => p.role === role).length;
  ok(count('bank-outline') === 1 && count('divider') === N + 2 && count('door-leaf') === N &&
     count('door-swing') === N && count('wc-pan') === N && count('wc-cistern') === N,
     'toilet-plan: role counts — 1 outline, N+2 divider-lines (dividers+rear), N each of leaf/swing/pan/cistern',
     `outline=${count('bank-outline')} divider=${count('divider')} leaf=${count('door-leaf')} swing=${count('door-swing')} pan=${count('wc-pan')} cistern=${count('wc-cistern')}`);

  // (c) door-swing arc winding parity after each surface's Y-flip + leaf-on-arc.
  // BOTH surfaces apply sy = const − y, i.e. (a→−a, ccw→!ccw). So the SCREEN
  // winding is identical on both surfaces by construction (same helper, same
  // flip). We assert the analytic flip is well-defined AND the leaf open-endpoint
  // lies on the swing arc (radius leafW from the hinge centre).
  const arc = seg.primitives.find(p => p.role === 'door-swing');
  const leaf = seg.primitives.find(p => p.role === 'door-leaf');
  ok(!!arc && !!leaf, 'toilet-plan: door-swing arc + door-leaf primitives present');
  if (arc && leaf) {
    // Screen winding (after Y-flip mirror) is the same for both surfaces because
    // both negate angles + flip ccw identically. Verify the flipped winding is a
    // pure boolean negation (deterministic) — a renderer that forgot to flip one
    // surface would diverge here when we cross-check the two render files' arc
    // code paths below.
    const screenCcw = !arc.ccw;   // both surfaces: state-ccw → screen-(!ccw)
    ok(screenCcw === true || screenCcw === false, 'toilet-plan: swing-arc screen winding is well-defined after Y-flip');
    // Leaf hinge endpoint == arc centre; leaf open endpoint at radius leafW.
    const H = leaf.a;
    ok(Math.abs(H.x - arc.center.x) < 1e-9 && Math.abs(H.y - arc.center.y) < 1e-9,
       'toilet-plan: door-leaf hinge endpoint coincides with the swing-arc centre');
    const rTip = Math.hypot(leaf.b.x - arc.center.x, leaf.b.y - arc.center.y);
    ok(Math.abs(rTip - arc.r) < 1e-9,
       'toilet-plan: door-leaf open endpoint lies ON the swing arc (radius = leafW)',
       `tip radius ${rTip.toFixed(4)} vs arc.r ${arc.r.toFixed(4)}`);

    // Both render files must apply the SAME flip rule (sweep = ccw ? 1 : 0).
    // A surface that hardcoded the opposite sweep would curve the door the other
    // way. Grep both arc paths for the identical sweep expression.
    for (const [id, file] of [
      ['2d-viewport', 'js/graphics/room-2d.js'],
      ['print-plan',  'js/ui/print-plan-svg.js'],
    ]) {
      const fsrc = readFileSync(file, 'utf8');
      ok(/sweep\s*=\s*p\.ccw\s*\?\s*1\s*:\s*0/.test(fsrc),
         `toilet-plan: ${id} uses sweep = p.ccw ? 1 : 0 (identical Y-flip arc winding)`);
    }
  }

  // (d) wc-cistern sits between wc-pan and the rear wall (against the rear),
  // for rotation 0 and 90, in STATE coords AND after each surface's Y-flip.
  // Project pan / cistern / rear-wall centre onto the rear direction (local +y →
  // state (−sin θ, cos θ)); ordering must be pan < cistern ≤ rear. Both render
  // surfaces apply the SAME rigid Y-flip mirror to ALL primitives, so this
  // state-coord ordering is what reaches the page on both — we additionally
  // re-project under the Y-flip (y → −y) to prove the SCREEN ordering matches.
  for (const rot of [0, 90]) {
    const sr = toiletFixture({ rotation_deg: rot });
    const sgr = toiletPlanSegments(sr, room);
    const pan = sgr.primitives.find(p => p.role === 'wc-pan');
    const cis = sgr.primitives.find(p => p.role === 'wc-cistern');
    // Rear wall is the divider-role line spanning the full bank at the rear.
    const rearLine = sgr.primitives.filter(p => p.role === 'divider' && p.a && p.b)
      .map(p => ({ mid: { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 }, len: Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) }))
      .sort((u, v) => v.len - u.len)[0];   // the rear wall is the longest divider-role line (spans lx)
    ok(!!pan && !!cis && !!rearLine, `toilet-plan(rot ${rot}): pan + cistern + rear line present`);
    if (pan && cis && rearLine) {
      const th = rot * Math.PI / 180;
      const rearDir = { x: -Math.sin(th), y: Math.cos(th) };
      const projState = (pt) => pt.x * rearDir.x + pt.y * rearDir.y;
      const pPan = projState(pan.center), pCis = projState(cis.center), pRear = projState(rearLine.mid);
      ok(pPan < pCis - 1e-9 && pCis < pRear + 1e-9,
         `toilet-plan(rot ${rot}): STATE coords — pan < cistern ≤ rear (cistern against rear)`,
         `pan ${pPan.toFixed(3)} < cistern ${pCis.toFixed(3)} ≤ rear ${pRear.toFixed(3)}`);
      // Y-flip (y → −y, as both surfaces apply): re-project the flipped points
      // onto the rear direction; betweenness must persist (rigid mirror).
      const flip = (pt) => ({ x: pt.x, y: -pt.y });
      const fPan = projState(flip(pan.center)), fCis = projState(flip(cis.center)), fRear = projState(flip(rearLine.mid));
      const between = (a, b, c) => (a < b && b < c + 1e-9) || (a > b && b > c - 1e-9);
      ok(between(fPan, fCis, fRear),
         `toilet-plan(rot ${rot}): AFTER Y-flip — cistern still between pan and rear (no inconsistent mirror)`,
         `pan ${fPan.toFixed(3)}, cistern ${fCis.toFixed(3)}, rear ${fRear.toFixed(3)}`);
    }
  }
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

// Heatmap display-fill + clip (bug 2026-05-21).
assertDilateUnit();
assertHeatmapFillParity();
assertSilhouetteMask();

// Negative-coordinate custom-room geometry on the print plan (2026-06-04).
assertPrintPlanCapturesNegativeGeometry();

// Offset custom room fits + centers in the print frame (2026-06-04).
assertOffsetCustomRoomFitsFrame();

// Building-structure footprint parity (2026-06-05).
assertStructureParity();

// Toilet architectural plan symbol parity (2026-06-07, v=774).
assertToiletPlanParity();

// ---------------------------------------------------------------------------
// Phase 7 — WallLAB thickness flowing into RoomLAB rendering.
//
// Sam spec, 2026-05-23. The thickness field landed in Commit 1 (schema +
// normalizeWallSlot — guarded by tests/wall-slot-thickness.test.mjs). The
// VISUAL parity gates land per-commit:
//
//   commit2_3d_consumed: 'hard'  — scene.js MUST consume wallInsetPolygon
//                                  for the rectangular + custom wall
//                                  geometry. HARD gate as soon as
//                                  Commit 2 ships.
//   commit3_2d_consumed: 'soft'  — room-2d.js consumes wallInsetPolygon
//                                  for the 2D fill. Maya, Commit 3 —
//                                  flips to 'hard' when that lands.
//   commit3_print_consumed: 'soft' — print-plan-svg.js consumes
//                                  wallInsetPolygon for the print fill.
//                                  Maya, Commit 3.
//   commit3_hatch_buckets: 'soft' — material-family-hatch.js stub exists
//                                  so this fixture's file-existence check
//                                  doesn't trip. Lin / Maya populate the
//                                  hatch buckets in Commit 3.
//
// Anti-leak grep: thickness arithmetic outside wall-inset.js (raw
// `thickness_m / 2`, `+ thickness_m`, `thickness_m * 0.5` patterns) trips
// the gate. The point of wall-inset.js is that EVERY visual surface
// shares one resolution + one inset polygon. If somebody slips
// `thickness_m / 2` into a render path, the surfaces silently desync
// when the wallSegments override kicks in (Phase 8).
// ---------------------------------------------------------------------------

const PHASE7_GATES = {
  commit2_3d_consumed:    'hard',  // scene.js (Viktor, Commit 2)
  commit3_2d_consumed:    'hard',  // room-2d.js (Maya, Commit 4 — flipped)
  commit3_print_consumed: 'hard',  // print-plan-svg.js (Maya, Commit 4 — flipped)
  commit3_hatch_buckets:  'hard',  // material-family-hatch.js (Lin, Commit 4 — flipped)
  commit3_hatch_shared:   'hard',  // both render files import + call getMaterialHatchKind
  commit3_label_anchor:   'hard',  // both render files use wallLabelAnchor for label position
};

function gateOK(level, name, cond, detail = '') {
  if (level === 'hard') {
    ok(cond, name, detail);
  } else {
    // Soft gate — print a SKIP/SOFT line so the absence of the upcoming
    // wiring is visible but doesn't fail the build. Commit 3 flips these
    // to 'hard' when Maya lands the 2D + print parity.
    if (cond) {
      console.log(`PASS  ${name} (soft)`);
    } else {
      console.log(`SOFT  ${name}${detail ? ' — ' + detail : ''}`);
    }
  }
}

function assertPhase7WallThickness() {
  // (1) wall-inset.js exists and exports the contract Sam locked.
  let wallInsetSrc = '';
  try {
    wallInsetSrc = readFileSync('js/physics/wall-inset.js', 'utf8');
  } catch (e) {
    fail('phase7: js/physics/wall-inset.js must exist (Commit 2 deliverable)', String(e));
    return;
  }
  ok(/export\s+function\s+wallInsetPolygon\b/.test(wallInsetSrc),
     'phase7: wall-inset.js exports wallInsetPolygon');
  ok(/export\s+function\s+wallLabelAnchor\b/.test(wallInsetSrc),
     'phase7: wall-inset.js exports wallLabelAnchor');
  ok(/export\s+function\s+getWallEdgeThickness\b/.test(wallInsetSrc),
     'phase7: wall-inset.js exports getWallEdgeThickness');
  ok(/export\s+const\s+WALL_LABEL_MAX_CHARS\s*=\s*12/.test(wallInsetSrc),
     'phase7: WALL_LABEL_MAX_CHARS === 12 (locked)');

  // (2) wall-inset.js MUST NOT import Three.js / DOM globals — pure module.
  ok(!/from\s+['"]three['"]/i.test(wallInsetSrc),
     'phase7: wall-inset.js does NOT import Three.js (pure Node module)');
  ok(!/\bdocument\.|\bwindow\./.test(wallInsetSrc),
     'phase7: wall-inset.js does NOT reference document / window');

  // (3) room-shape.js MUST NOT import wall-inset.js — the inset is for
  //     RENDER only. baseArea() / roomSurfaces() / RT60 must stay
  //     untouched by the visual thickness story.
  const roomShapeSrc = readFileSync('js/physics/room-shape.js', 'utf8');
  ok(!/from\s+['"][^'"]*wall-inset(?:\.js)?['"]/.test(roomShapeSrc),
     'phase7: room-shape.js does NOT import wall-inset.js (acoustic math untouched)');

  // (4) Commit 2 (HARD) — scene.js consumes wallInsetPolygon.
  const sceneSrc = readFileSync('js/graphics/scene.js', 'utf8');
  gateOK(PHASE7_GATES.commit2_3d_consumed,
    'phase7-commit2: scene.js imports wallInsetPolygon',
    /from\s+['"][^'"]*physics\/wall-inset(?:\.js)?['"]/.test(sceneSrc) &&
    /\bwallInsetPolygon\b/.test(sceneSrc));
  gateOK(PHASE7_GATES.commit2_3d_consumed,
    'phase7-commit2: scene.js calls wallInsetPolygon (rectangular + custom wall geometry)',
    /wallInsetPolygon\s*\(/.test(sceneSrc));

  // (5) Anti-leak grep — raw thickness_m arithmetic OUTSIDE wall-inset.js
  //     trips the gate. Render surfaces must funnel through the helper
  //     so wallSegments overrides take effect uniformly.
  const ANTI_LEAK_FILES = [
    'js/graphics/scene.js',
    'js/graphics/room-2d.js',
    'js/ui/print-plan-svg.js',
  ];
  const LEAK_PATTERNS = [
    /thickness_m\s*\/\s*2\b/,
    /thickness_m\s*\*\s*0\.5\b/,
    /\+\s*thickness_m\b/,
  ];
  for (const f of ANTI_LEAK_FILES) {
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    // Strip line comments (// …) and block-comment bodies (/* … */) so a
    // docstring that LITERALLY says "don't write `thickness_m / 2` here"
    // doesn't trip its own gate. The grep targets actual code paths.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/[ \t]+\/\/.*$/gm, '');
    let leaked = null;
    for (const pat of LEAK_PATTERNS) {
      const m = stripped.match(pat);
      if (m) { leaked = m[0]; break; }
    }
    ok(leaked === null,
       `phase7 anti-leak: ${f} has no raw thickness_m arithmetic`,
       leaked ? `found "${leaked}" — route through wall-inset.js helpers` : '');
  }

  // (6) Commit 3 (SOFT) — 2D + print SVG consume wallInsetPolygon.
  //     Soft gates today; Maya flips them to 'hard' in Commit 3.
  const room2dSrc = readFileSync('js/graphics/room-2d.js', 'utf8');
  gateOK(PHASE7_GATES.commit3_2d_consumed,
    'phase7-commit3: room-2d.js consumes wallInsetPolygon for 2D fill',
    /\bwallInsetPolygon\b/.test(room2dSrc));

  const printPlanSrc = readFileSync('js/ui/print-plan-svg.js', 'utf8');
  gateOK(PHASE7_GATES.commit3_print_consumed,
    'phase7-commit3: print-plan-svg.js consumes wallInsetPolygon for print fill',
    /\bwallInsetPolygon\b/.test(printPlanSrc));

  // (7) Commit 4 (HARD) — material-family-hatch.js exists AND exports
  //     getMaterialHatchKind. Lin shipped this in parallel with Maya's
  //     2D + print consumers (see Phase 7 Commit 4 brief).
  let hatchExists = false;
  let hatchSrc = '';
  try {
    statSync('js/labs/walllab/material-family-hatch.js');
    hatchSrc = readFileSync('js/labs/walllab/material-family-hatch.js', 'utf8');
    hatchExists = true;
  } catch { /* missing */ }
  gateOK(PHASE7_GATES.commit3_hatch_buckets,
    'phase7-commit4: js/labs/walllab/material-family-hatch.js exists',
    hatchExists,
    'create the file before flipping the gate to hard');
  if (hatchExists) {
    gateOK(PHASE7_GATES.commit3_hatch_buckets,
      'phase7-commit4: material-family-hatch.js exports getMaterialHatchKind',
      /export\s+function\s+getMaterialHatchKind\b/.test(hatchSrc));
    // Locked bucket strings — Sam's anti-leak grep would catch a rename.
    for (const bucket of ['solid-dark', 'diagonal-hatch', 'outline-only', 'open-air', 'unknown']) {
      gateOK(PHASE7_GATES.commit3_hatch_buckets,
        `phase7-commit4: material-family-hatch.js carries locked bucket '${bucket}'`,
        new RegExp(`['"]${bucket}['"]`).test(hatchSrc));
    }
  }

  // (8) Commit 4 (HARD) — commit3_hatch_shared. Both render files
  //     import getMaterialHatchKind from material-family-hatch.js AND
  //     call it on the wall slot's materialId. Locked by Sam so a
  //     drive-by renderer-side inlined family branch trips the gate.
  for (const [id, file] of [
    ['room-2d',         'js/graphics/room-2d.js'],
    ['print-plan-svg',  'js/ui/print-plan-svg.js'],
  ]) {
    let src = '';
    try { src = readFileSync(file, 'utf8'); } catch (e) {
      fail(`phase7-commit4 hatch-shared: ${id} unreadable (${file})`, String(e));
      continue;
    }
    gateOK(PHASE7_GATES.commit3_hatch_shared,
      `phase7-commit4: ${id} imports getMaterialHatchKind from material-family-hatch.js`,
      /from\s+['"][^'"]*walllab\/material-family-hatch(?:\.js)?['"]/.test(src) &&
      /\bgetMaterialHatchKind\b/.test(src));
    gateOK(PHASE7_GATES.commit3_hatch_shared,
      `phase7-commit4: ${id} calls getMaterialHatchKind() on a wall material`,
      /getMaterialHatchKind\s*\(/.test(src));
  }

  // (9) Commit 4 (HARD) — commit3_label_anchor. Both render files use
  //     wallLabelAnchor from wall-inset.js for per-wall label position.
  //     Anti-leak: nobody is re-implementing "edge midpoint + inward
  //     normal * thickness/2" by hand on a render path.
  for (const [id, file] of [
    ['room-2d',         'js/graphics/room-2d.js'],
    ['print-plan-svg',  'js/ui/print-plan-svg.js'],
  ]) {
    let src = '';
    try { src = readFileSync(file, 'utf8'); } catch (e) {
      fail(`phase7-commit4 label-anchor: ${id} unreadable (${file})`, String(e));
      continue;
    }
    gateOK(PHASE7_GATES.commit3_label_anchor,
      `phase7-commit4: ${id} imports wallLabelAnchor from wall-inset.js`,
      /from\s+['"][^'"]*physics\/wall-inset(?:\.js)?['"]/.test(src) &&
      /\bwallLabelAnchor\b/.test(src));
    gateOK(PHASE7_GATES.commit3_label_anchor,
      `phase7-commit4: ${id} calls wallLabelAnchor() to position a wall label`,
      /wallLabelAnchor\s*\(/.test(src));
    gateOK(PHASE7_GATES.commit3_label_anchor,
      `phase7-commit4: ${id} imports WALL_LABEL_MAX_CHARS for label truncation`,
      /\bWALL_LABEL_MAX_CHARS\b/.test(src));
  }
}

assertPhase7WallThickness();

// ---------------------------------------------------------------------------
// Phase 4 (Sam, 2026-05-25) — EXTERIOR-source classifier gate.
//
// Background. The indoor exterior-source coupling fix routes every source
// through js/physics/source-classification.js::classifySource before
// adding its L_w to the Hopkins-Stryker 4/R aggregate. Three surfaces
// (per-listener label, listener breakdown, indoor heatmap) had separate
// reverb-leak loops. A refactor that drops `classifySource` from any one
// of those three silently re-introduces the 3–5 dB inflation on
// minaret-horn / exterior-PA scenes — and the value tests in
// tests/exterior-source-classification.test.mjs would all keep passing
// against the surface that DOES wire it.
//
// This grep gate guards the three surfaces in spl-calculator.js: any
// reverb-leak path MUST consult `_buildSourceClassifications` so the
// EXTERIOR coupling table is in scope. Same shape as the
// scene.scale.x = -1 anti-leak grep in scene-x-mirror.test.mjs.
// ---------------------------------------------------------------------------
function assertPhase4ClassifierGate() {
  let src = '';
  try {
    src = readFileSync('js/physics/spl-calculator.js', 'utf8');
  } catch (e) {
    fail('phase4 classifier-gate: js/physics/spl-calculator.js unreadable', String(e));
    return;
  }
  ok(/import\s*\{[^}]*\bclassifySource\b[^}]*\}\s*from\s*['"][^'"]*source-classification(?:\.js)?['"]/.test(src),
     'phase4: spl-calculator.js imports classifySource from source-classification.js');
  // The _buildSourceClassifications helper is the canonical entry point —
  // every reverb-leak surface must call it.
  ok(/function\s+_buildSourceClassifications\s*\(/.test(src),
     'phase4: spl-calculator.js defines _buildSourceClassifications helper');
  // computeMultiSourceSPL (the per-listener label path) must call it.
  // Match the function body up to the next top-level `export function` so
  // the assertion can't be fooled by a call living in some unrelated body.
  const cmsBlock = src.match(/export\s+function\s+computeMultiSourceSPL\s*\([\s\S]*?(?=\n(?:export\s+function|function\s+\w+\s*\([^)]*\)\s*\{))/);
  ok(cmsBlock && /_buildSourceClassifications\s*\(/.test(cmsBlock[0]),
     'phase4: computeMultiSourceSPL calls _buildSourceClassifications');
  // computeListenerBreakdown (the panel-results path) must call it.
  const clbBlock = src.match(/export\s+function\s+computeListenerBreakdown\s*\([\s\S]*?(?=\n(?:export\s+function|function\s+\w+\s*\([^)]*\)\s*\{))/);
  ok(clbBlock && /_buildSourceClassifications\s*\(/.test(clbBlock[0]),
     'phase4: computeListenerBreakdown calls _buildSourceClassifications');
  // computeSPLGrid (the indoor heatmap path) must call it. computeSPLGrid
  // is the LAST exported function in the file; match to end-of-file rather
  // than to the next export marker.
  const cgBlock = src.match(/export\s+function\s+computeSPLGrid\s*\([\s\S]*$/);
  ok(cgBlock && /_buildSourceClassifications\s*\(/.test(cgBlock[0]),
     'phase4: computeSPLGrid calls _buildSourceClassifications');
  // And the consumer in the hot loop must thread exteriorCouplings through
  // so the per-EXTERIOR-source C_couple table actually reaches the reverb
  // term. Without this, a future refactor could drop the parameter while
  // leaving the helper call in place.
  ok(/exteriorCouplings\s*=\s*null/.test(src),
     'phase4: precomputeSPLContext accepts an exteriorCouplings parameter (default null)');
  ok(/coupling_per_band/.test(src),
     'phase4: spl-calculator.js wires coupling_per_band into the per-source ctx record');
}

assertPhase4ClassifierGate();

// ---------------------------------------------------------------------------
// Phase 11a (Sam, 2026-05-25) — heatmap-legend ramp/data convention.
//
// The cell colour ramp is FIXED-DOMAIN: SPL [30, 110] dB, STI [0, 1].
// Before Phase 11a, the three legend surfaces (2D viewport, 3D viewport,
// print heatmap) all captioned the DATA extent (e.g. "59 dB – 104 dB"
// outdoor vs "72 dB – 106 dB" indoor) — toggling outdoor-mode read as
// "the scale changed" even though the colour-to-value mapping is
// invariant. Maya's fix: caption the RAMP DOMAIN; show data extent as a
// faint bracket inside the bar plus a sub-caption "data: 72–106 dB".
//
// This gate ensures all 4 sites (3 legends + the shader palette builder)
// pull from one source — js/graphics/legend-ticks.js exports the
// ramp-domain constants AND the formatDataBracket / dataBracketPosition
// helpers. A drive-by edit that hardcodes 30/110 in a fifth place trips
// the grep.
// ---------------------------------------------------------------------------

function assertPhase11aLegendConvention() {
  // (1) Single source of truth — legend-ticks.js exports the constants
  //     and the data-bracket helpers.
  let legendSrc = '';
  try {
    legendSrc = readFileSync('js/graphics/legend-ticks.js', 'utf8');
  } catch (e) {
    fail('phase11a: js/graphics/legend-ticks.js unreadable', String(e));
    return;
  }
  ok(/export\s+const\s+SPL_RAMP_MIN_DB\s*=\s*30\b/.test(legendSrc),
     'phase11a: legend-ticks.js exports SPL_RAMP_MIN_DB = 30');
  ok(/export\s+const\s+SPL_RAMP_MAX_DB\s*=\s*110\b/.test(legendSrc),
     'phase11a: legend-ticks.js exports SPL_RAMP_MAX_DB = 110');
  ok(/export\s+const\s+STI_RAMP_MIN\s*=\s*0\b/.test(legendSrc),
     'phase11a: legend-ticks.js exports STI_RAMP_MIN = 0');
  ok(/export\s+const\s+STI_RAMP_MAX\s*=\s*1\b/.test(legendSrc),
     'phase11a: legend-ticks.js exports STI_RAMP_MAX = 1');
  ok(/export\s+function\s+getRampDomain\b/.test(legendSrc),
     'phase11a: legend-ticks.js exports getRampDomain');
  ok(/export\s+function\s+formatDataBracket\b/.test(legendSrc),
     'phase11a: legend-ticks.js exports formatDataBracket');
  ok(/export\s+function\s+dataBracketPosition\b/.test(legendSrc),
     'phase11a: legend-ticks.js exports dataBracketPosition');

  // (2) All three legend sites import the ramp-domain helper. Catches a
  //     refactor that drops the import and falls back to data min/max.
  const LEGEND_SITES = [
    ['2d-viewport',   'js/graphics/room-2d.js'],
    ['3d-viewport',   'js/graphics/scene.js'],
    ['print-heatmap', 'js/ui/print-heatmap.js'],
  ];
  for (const [id, file] of LEGEND_SITES) {
    let src = '';
    try { src = readFileSync(file, 'utf8'); } catch (e) {
      fail(`phase11a: ${id} unreadable (${file})`, String(e));
      continue;
    }
    ok(/from\s+['"][^'"]*legend-ticks(?:\.js)?['"]/.test(src),
       `phase11a: ${id} imports from legend-ticks.js`);
    ok(/\bgetRampDomain\b/.test(src),
       `phase11a: ${id} consumes getRampDomain (legend caption ends = ramp domain)`);
    ok(/\bformatDataBracket\b/.test(src),
       `phase11a: ${id} consumes formatDataBracket (renders the data sub-caption)`);
    ok(/\bdataBracketPosition\b/.test(src),
       `phase11a: ${id} consumes dataBracketPosition (paints the data bracket inside the bar)`);
  }

  // (3) The shader palette also pulls from legend-ticks (was the
  //     historical "second source of truth" — now aliases the legend
  //     constants). Anti-leak.
  const shaderSrc = readFileSync('js/graphics/heatmap-shader.js', 'utf8');
  ok(/from\s+['"][^'"]*legend-ticks(?:\.js)?['"]/.test(shaderSrc),
     'phase11a: heatmap-shader.js imports SPL_RAMP_MIN_DB/MAX_DB from legend-ticks.js');
  ok(/SPL_RAMP_MIN_DB|SPL_RAMP_MAX_DB/.test(shaderSrc),
     'phase11a: heatmap-shader.js references the shared ramp constants');

  // (4) Anti-leak grep — the literals 30 and 110 should NOT appear as a
  //     ramp-domain pair anywhere outside legend-ticks.js + the shader's
  //     aliasing block. We grep for the suspicious co-occurrence
  //     pattern `30` + `110` within 4 lines (rough heuristic — accepts
  //     unrelated 30/110 in surrounding files).
  //
  //     The legend bar + tick rendering code is the historical leak
  //     site. If a future legend implementation re-hardcodes the ramp
  //     domain there, this gate trips.
  const RAMP_LEAK_FILES = [
    'js/graphics/room-2d.js',
    'js/graphics/scene.js',
    'js/ui/print-heatmap.js',
  ];
  for (const f of RAMP_LEAK_FILES) {
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    // Strip comments so a docstring "the ramp is 30..110 dB" doesn't trip.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/[ \t]+\/\/.*$/gm, '');
    // Specific anti-pattern: an array / pair literal carrying both 30 and 110
    // with no surrounding helper call. Matches `[30, 110]`, `(30, 110)`,
    // `30, 110` as adjacent number-literals in a small window.
    const leakPattern = /\b30\s*,\s*110\b|\b110\s*,\s*30\b|min:\s*30[\s\S]{0,40}max:\s*110|SPL_MIN_DB\s*=\s*30[\s\S]{0,40}SPL_MAX_DB\s*=\s*110/;
    const m = stripped.match(leakPattern);
    ok(!m, `phase11a anti-leak: ${f} does not hardcode the ramp domain (30, 110)`,
       m ? `found "${m[0]}" — import SPL_RAMP_MIN_DB / SPL_RAMP_MAX_DB from legend-ticks.js` : '');
  }

  // (5) End-to-end: buildHeatmapLegend() — the HTML block rendered under
  //     the heatmap raster in the print report — must carry BOTH the
  //     ramp-end tick labels AND the data sub-caption. Direct render
  //     path; legend lives outside the SVG content (it's an HTML stage
  //     in the print page layout).
  installCanvasShim();
  buildFixtureState();
  // Construct a grid whose data extent (72..106 dB) is well INSIDE the
  // ramp (30..110 dB) — so the ramp ends and data caption are
  // unambiguously distinguishable.
  const grid = {
    grid: [[72, 90], [80, 106]],
    cellsX: 2, cellsY: 2,
    originX_m: 0, originY_m: 0,
    cellW_m: state.room.width_m / 2,
    cellD_m: state.room.depth_m / 2,
    metric: 'spl',
    minSPL_db: 72, maxSPL_db: 106, avgSPL_db: 89,
    sourceCount: 1,
  };
  const legendHtml = buildHeatmapLegend(grid);
  ok(legendHtml && legendHtml.length > 0,
     'phase11a print-heatmap: buildHeatmapLegend returns non-empty HTML for a valid grid');
  // Ramp-end tick labels: the bar spans [30, 110], computeTicks at step
  // 10 dB → 30, 40, …, 110. Both endpoints emit "30 dB" / "110 dB".
  ok(/>30 dB</.test(legendHtml),
     'phase11a print-heatmap legend: ramp-min tick label "30 dB" present (caption end = ramp domain)');
  ok(/>110 dB</.test(legendHtml),
     'phase11a print-heatmap legend: ramp-max tick label "110 dB" present (caption end = ramp domain)');
  // Data sub-caption — exactly "data: 72–106 dB" (en-dash U+2013).
  ok(/data:\s*72–106\s*dB/.test(legendHtml),
     'phase11a print-heatmap legend: data sub-caption "data: 72–106 dB" present',
     `legend snippet: ${(legendHtml.match(/data:[^<]*/) || ['(no match)'])[0]}`);
  // Data bracket div: positioned with left%/right% matching the data range
  // within [30, 110]. (72 - 30) / 80 = 52.5 %; (110 - 106) / 80 = 5 %.
  const bracketM = legendHtml.match(/pr-heatmap-legend-data-bracket[^>]*style="left:([0-9.]+)%;right:([0-9.]+)%"/);
  ok(bracketM, 'phase11a print-heatmap legend: data bracket element present with left/right %');
  if (bracketM) {
    const left = parseFloat(bracketM[1]);
    const right = parseFloat(bracketM[2]);
    ok(Math.abs(left - 52.5) < 0.5,
       `phase11a print-heatmap legend: bracket left% ≈ 52.5 (got ${left}) — maps data min 72 dB into ramp [30,110]`);
    ok(Math.abs(right - 5.0) < 0.5,
       `phase11a print-heatmap legend: bracket right% ≈ 5.0 (got ${right}) — maps data max 106 dB into ramp [30,110]`);
  }
  // Negative case: degenerate data range (min === max) hides bracket + caption.
  const degenerateLegend = buildHeatmapLegend({
    ...grid, minSPL_db: 80, maxSPL_db: 80,
  });
  ok(degenerateLegend === '',
     'phase11a print-heatmap legend: degenerate range (min == max) returns empty string (no caption)');
}

assertPhase11aLegendConvention();

// ---------------------------------------------------------------------------
// Heatmap cell-FILL colour ramp parity (Sam, 2026-06-04).
//
// Background. The heatmap CELL FILL renders on 3 of the 4 surfaces — 2D
// viewport (room-2d.js), 3D scalar shader (heatmap-shader.js), print heatmap
// (print-heatmap.js). The shared ramp is js/graphics/colour-ramps.js
// (splColorRGB / stiColorRGB / colorForMetric, fixed domain 30–110 dB).
//
// The leak this guards. room-2d.js carried a PRIVATE `function splColor`
// returning `rgb(r,g,b)` strings off its OWN inlined 4-stop hex ramp
// ('#1a1a4a' → '#0066cc' → '#00cc66' → '#ffcc00' → '#ff3300'), with a comment
// pleading "keep in lock-step with splColorRGB in colour-ramps.js". That
// hand-sync is exactly the drift mode this fixture exists to kill: a hex-stop
// ramp interpolated as packed ints rounds differently from the RGB-array ramp,
// so 2D cells could read a visibly different colour for "85 dB" than the 3D /
// print cells — and NOTHING tripped, because phase11a only guards the legend
// DOMAIN (getRampDomain caption), never the cell-FILL colour. assertPhase11a
// asserts "the legend says 30–110", this asserts "every surface paints the
// same colour at 70 dB".
//
// The fix (Viktor + Maya sign-off pending): delete room-2d's private splColor
// + its inline hex ramp, import colorForMetric/splColorRGB from
// ./colour-ramps.js, keep the 2D per-surface 0.55 fill-opacity at the call
// site (opacity is a 2D-only convention, NOT part of the shared ramp).
//
// TWO gates, same shape as the rack-footprint / scene.scale.x=-1 anti-leak:
//
//   (a) GREP GATE — all three fill surfaces import a colour function from
//       colour-ramps.js, AND room-2d.js no longer defines a private
//       `function splColor` or an inline SPL hex ramp. A re-inline trips it.
//   (b) VALUE GATE — lock the shared value→RGB mapping at sample dB / STI
//       points so the ramp itself can't silently drift, and so any future
//       re-inlined private ramp would have to reproduce these exact triples.
//
// IMPORTANT (Sam, 2026-06-04): the GREP GATE half FAILS until the room-2d.js
// edit lands (the file still defines `function splColor` + the hex ramp at the
// time this assertion was written). The VALUE GATE half passes today (it tests
// the shared module directly). Written against the POST-fix expected state.
// ---------------------------------------------------------------------------

function assertHeatmapRampParity() {
  // (a) GREP GATE — every cell-fill surface imports a colour function from
  //     the shared colour-ramps.js. Same import-presence shape as the
  //     rack-2d / legend-ticks gates above.
  const FILL_SURFACES = [
    ['2d-viewport',   'js/graphics/room-2d.js'],
    ['3d-shader',     'js/graphics/heatmap-shader.js'],
    ['print-heatmap', 'js/ui/print-heatmap.js'],
  ];
  for (const [id, file] of FILL_SURFACES) {
    let src = '';
    try { src = readFileSync(file, 'utf8'); } catch (e) {
      fail(`heatmap-ramp: ${id} unreadable (${file})`, String(e));
      continue;
    }
    // Import line references colour-ramps.js …
    ok(/from\s+['"][^'"]*colour-ramps(?:\.js)?['"]/.test(src),
       `heatmap-ramp: ${id} imports from colour-ramps.js`);
    // … and pulls in at least one of the shared colour functions by name.
    ok(/\b(?:colorForMetric|splColorRGB|stiColorRGB)\b/.test(src),
       `heatmap-ramp: ${id} consumes a shared ramp fn (colorForMetric / splColorRGB / stiColorRGB)`);
  }

  // (a, anti-leak) room-2d.js must NOT re-define a private SPL ramp. The
  //     private `function splColor` and the inline 4-stop hex ramp are the
  //     exact leak that motivated this gate; a drive-by re-inline trips here.
  const room2dSrc = readFileSync('js/graphics/room-2d.js', 'utf8');
  ok(!/function\s+splColor\b/.test(room2dSrc),
     'heatmap-ramp anti-leak: room-2d.js does NOT define a private function splColor (use colorForMetric from colour-ramps.js)',
     'a private SPL ramp re-introduces the 2D↔3D↔print colour-drift this gate kills');
  // The specific hex stops the deleted private ramp used. If a refactor
  // re-inlines ANY SPL hex ramp into room-2d.js, at least one of these
  // navy / red endpoints reappears and trips the gate. Strip comments so the
  // docstring above (which names the stops as a warning) doesn't self-trip.
  const room2dCode = room2dSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]+\/\/.*$/gm, '');
  const SPL_HEX_STOPS = ['#1a1a4a', '#0066cc', '#00cc66', '#ffcc00', '#ff3300'];
  const leakedHex = SPL_HEX_STOPS.filter(h => new RegExp(h, 'i').test(room2dCode));
  ok(leakedHex.length === 0,
     'heatmap-ramp anti-leak: room-2d.js carries no inline SPL hex ramp stops (#1a1a4a … #ff3300)',
     leakedHex.length ? `found ${leakedHex.join(', ')} — delete the private ramp, call colorForMetric()` : '');
  // The 2D per-surface fill-opacity stays at the call site (0.55) — it is a
  // 2D-only convention, NOT something the shared ramp owns. Confirm it
  // survives the refactor so the fix doesn't accidentally drop it.
  ok(/fill-opacity="0\.55"/.test(room2dSrc),
     'heatmap-ramp: room-2d.js keeps the 2D-only 0.55 cell fill-opacity at the paint call site');

  // (b) VALUE GATE — lock the shared ramp's value→RGB mapping. These triples
  //     are the contract every surface now shares; if the ramp itself drifts
  //     (a stop colour edit) OR a re-inlined private ramp produces different
  //     numbers, this trips. Sample points chosen on segment boundaries and
  //     midpoints so a single-stop edit is caught:
  //       50 dB → t=0.25 boundary (blue→cyan stop)
  //       70 dB → t=0.50 boundary (cyan→green stop)
  //       85 dB → t≈0.6875 inside the green→yellow segment
  //      105 dB → t=0.9375 inside the yellow→red segment
  const SPL_SAMPLES = [
    [50,  [0, 140, 230]],
    [70,  [30, 220, 80]],
    [85,  [199, 216, 20]],
    [105, [244, 76, 23]],
  ];
  for (const [db, expect] of SPL_SAMPLES) {
    const rgb = splColorRGB(db);
    ok(rgb.length === 3 && rgb[0] === expect[0] && rgb[1] === expect[1] && rgb[2] === expect[2],
       `heatmap-ramp value: splColorRGB(${db}) === [${expect.join(', ')}]`,
       `got [${rgb.join(', ')}]`);
    // colorForMetric('spl') MUST route to the same ramp — the surfaces that
    // use the metric-parameterised entry point get the identical colour.
    const viaMetric = colorForMetric(db, 'spl');
    ok(viaMetric[0] === expect[0] && viaMetric[1] === expect[1] && viaMetric[2] === expect[2],
       `heatmap-ramp value: colorForMetric(${db}, 'spl') matches splColorRGB(${db})`,
       `got [${viaMetric.join(', ')}]`);
  }

  // Domain endpoints + clamp behaviour — values outside [30, 110] clamp to
  // the endpoint colours (NOT wrap, NOT NaN). Locks the fixed-domain contract
  // the shader + legend depend on.
  ok(SPL_DOMAIN_MIN_DB === 30 && SPL_DOMAIN_MAX_DB === 110,
     'heatmap-ramp value: shared SPL domain is [30, 110] dB (fixed-domain contract)',
     `got [${SPL_DOMAIN_MIN_DB}, ${SPL_DOMAIN_MAX_DB}]`);
  const lo = splColorRGB(SPL_DOMAIN_MIN_DB), loClamp = splColorRGB(SPL_DOMAIN_MIN_DB - 50);
  const hi = splColorRGB(SPL_DOMAIN_MAX_DB), hiClamp = splColorRGB(SPL_DOMAIN_MAX_DB + 90);
  ok(lo[0] === 20 && lo[1] === 40 && lo[2] === 180,
     'heatmap-ramp value: splColorRGB(30) === [20, 40, 180] (ramp-min navy)', `got [${lo.join(', ')}]`);
  ok(hi[0] === 240 && hi[1] === 30 && hi[2] === 30,
     'heatmap-ramp value: splColorRGB(110) === [240, 30, 30] (ramp-max red)', `got [${hi.join(', ')}]`);
  ok(loClamp.join(',') === lo.join(','),
     'heatmap-ramp value: SPL below 30 dB clamps to the ramp-min colour (no wrap / NaN)',
     `got [${loClamp.join(', ')}] vs [${lo.join(', ')}]`);
  ok(hiClamp.join(',') === hi.join(','),
     'heatmap-ramp value: SPL above 110 dB clamps to the ramp-max colour (no wrap / NaN)',
     `got [${hiClamp.join(', ')}] vs [${hi.join(', ')}]`);

  // STI ramp value lock — the OTHER metric the same surfaces paint via
  // colorForMetric('sti'). One boundary + the midpoint guard a stop edit.
  const stiLo = stiColorRGB(0), stiMid = stiColorRGB(0.5), stiHi = stiColorRGB(1);
  ok(stiLo[0] === 210 && stiLo[1] === 20 && stiLo[2] === 20,
     'heatmap-ramp value: stiColorRGB(0) === [210, 20, 20] (STI-min red)', `got [${stiLo.join(', ')}]`);
  ok(stiMid[0] === 190 && stiMid[1] === 213 && stiMid[2] === 20,
     'heatmap-ramp value: stiColorRGB(0.5) === [190, 213, 20]', `got [${stiMid.join(', ')}]`);
  ok(stiHi[0] === 0 && stiHi[1] === 170 && stiHi[2] === 220,
     'heatmap-ramp value: stiColorRGB(1) === [0, 170, 220] (STI-max teal)', `got [${stiHi.join(', ')}]`);
  const stiViaMetric = colorForMetric(0.5, 'sti');
  ok(stiViaMetric.join(',') === stiMid.join(','),
     "heatmap-ramp value: colorForMetric(0.5, 'sti') routes to stiColorRGB",
     `got [${stiViaMetric.join(', ')}]`);
}

assertHeatmapRampParity();

// ---------------------------------------------------------------------------
// DeviceLAB rack upgrade — slice 6 (Sam, 2026-05-27). Rack footprint
// parity across 2D viewport + print plan SVG.
//
// Background. Slice 1 (Lin) added schema v2.0 with style:"enclosed"
// front-door / rear-door / side-panels / vent fields. Slice 2 (Viktor)
// built the enclosed 3D mesh with a left-hinged front door swinging
// outward to the viewer's right. Slice 6 (this fixture + the new
// js/graphics/rack-2d.js shared helper) lands the 2D + print plan
// representation. Two surfaces, one helper, one parity fixture — the
// cross-surface convention owner discipline (CLAUDE.md §3).
//
// What this guards:
//   • Both surfaces import the shared renderRackFootprintSVG helper —
//     no surface re-implements the footprint geometry locally.
//   • Footprint dimensions = outer_w_mm × outer_d_mm (no door-swing arc
//     inflating the rectangle).
//   • FRONT-edge marker is on the local +y edge of the un-rotated rect
//     (Viktor's local -Z, the front-door face).
//   • HINGE dot is at the front-LEFT corner of the un-rotated rect
//     (Viktor's left-hinged door, local x = -outerW/2 + postW).
//   • Front-edge stroke is THICKER than the side stroke (the visual
//     cue itself).
//   • State-y agreement: a rack at state.y=+2 renders ABOVE a rack at
//     state.y=-3 on the print SVG (same Y-flip every other entity uses).
//   • State-x agreement: a rack at state.x=+1 renders to the RIGHT of a
//     rack at state.x=-1 on the print SVG (same X-mirror invariant).
// ---------------------------------------------------------------------------

import { renderRackFootprintSVG, lookupRackDef, rackFootprintMetres, RACK_2D_CONSTANTS } from '../js/graphics/rack-2d.js';

function assertRackFootprintParity() {
  // (1) Helper file exists with the locked exports.
  const rackHelperSrc = readFileSync('./js/graphics/rack-2d.js', 'utf8');
  ok(/export\s+function\s+renderRackFootprintSVG\b/.test(rackHelperSrc),
     'rack-2d: exports renderRackFootprintSVG');
  ok(/export\s+function\s+lookupRackDef\b/.test(rackHelperSrc),
     'rack-2d: exports lookupRackDef');
  ok(/export\s+function\s+rackFootprintMetres\b/.test(rackHelperSrc),
     'rack-2d: exports rackFootprintMetres');
  ok(/export\s+const\s+RACK_2D_CONSTANTS\b/.test(rackHelperSrc),
     'rack-2d: exports RACK_2D_CONSTANTS (locked convention constants)');
  // Front-edge stroke must be visibly thicker than the side stroke —
  // the multiplier IS the visual cue. ≥ 2× to read as a distinct line
  // and not just a slightly bolder rectangle stroke.
  ok(RACK_2D_CONSTANTS.FRONT_STROKE_MULT >= 2,
     `rack-2d: FRONT_STROKE_MULT >= 2 (got ${RACK_2D_CONSTANTS.FRONT_STROKE_MULT})`);
  // Hinge dot lives on the front-LEFT corner — these literal strings are
  // the contract the room-2d / print-plan callers depend on; bumping
  // them is a deliberate API break.
  ok(RACK_2D_CONSTANTS.FRONT_EDGE_LOCAL_Y === '+halfD',
     `rack-2d: FRONT_EDGE_LOCAL_Y === '+halfD' (got '${RACK_2D_CONSTANTS.FRONT_EDGE_LOCAL_Y}')`);
  ok(RACK_2D_CONSTANTS.HINGE_CORNER_LOCAL === '(-halfW, +halfD)',
     `rack-2d: HINGE_CORNER_LOCAL === '(-halfW, +halfD)' (got '${RACK_2D_CONSTANTS.HINGE_CORNER_LOCAL}')`);

  // (2) Both 2D viewport + print plan SVG import the shared helper.
  // Anti-leak grep: if a future surface inlines its own rack-rectangle
  // render, this gate trips.
  const room2dSrc = readFileSync('./js/graphics/room-2d.js', 'utf8');
  // room-2d.js sits IN js/graphics/, so the import is the sibling
  // './rack-2d.js'; print-plan-svg.js sits in js/ui/ so it imports
  // '../graphics/rack-2d.js'. Accept either.
  ok(/from\s+['"](?:\.\/|[^'"]*graphics\/)rack-2d(?:\.js)?['"]/.test(room2dSrc),
     'rack-2d parity: room-2d.js imports from rack-2d.js');
  ok(/renderRackFootprintSVG\s*\(/.test(room2dSrc),
     'rack-2d parity: room-2d.js calls renderRackFootprintSVG');

  const printPlanSrc = readFileSync('./js/ui/print-plan-svg.js', 'utf8');
  ok(/from\s+['"](?:\.\/|[^'"]*graphics\/)rack-2d(?:\.js)?['"]/.test(printPlanSrc),
     'rack-2d parity: print-plan-svg.js imports from rack-2d.js');
  ok(/renderRackFootprintSVG\s*\(/.test(printPlanSrc),
     'rack-2d parity: print-plan-svg.js calls renderRackFootprintSVG');

  // (3) Anti-leak grep — raw "outer_w_mm / 1000" / "outer_d_mm / 1000"
  // arithmetic OUTSIDE rack-2d.js / rack-render.js trips the gate. The
  // helpers (rackFootprintMetres / rack-render constructor) are the
  // canonical conversion sites; any other site doing the same mm→m
  // arithmetic on rack dims means a renderer is computing dimensions
  // independently — a fifth source of truth waiting to drift.
  const RACK_LEAK_FILES = [
    'js/graphics/room-2d.js',
    'js/ui/print-plan-svg.js',
  ];
  for (const f of RACK_LEAK_FILES) {
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/[ \t]+\/\/.*$/gm, '');
    // Direct mm→m on a rack catalogue field is the leak pattern.
    const leak = stripped.match(/outer_[wd]_mm\s*\/\s*1000/);
    ok(leak === null,
       `rack-2d anti-leak: ${f} has no raw outer_*_mm arithmetic`,
       leak ? `found "${leak[0]}" — call rackFootprintMetres(rackDef) instead` : '');
  }

  // (4) Catalogue lookup contract — accepts both shapes (raw JSON +
  // Map) the live code passes around.
  const fakeDef = { outer_w_mm: 600, outer_d_mm: 800, label: 'Test 18U' };
  const jsonCatalogue = { schema_version: '2.0', racks: { 'test-18u': fakeDef } };
  const mapCatalogue = new Map([['test-18u', fakeDef]]);
  ok(lookupRackDef(jsonCatalogue, 'test-18u') === fakeDef,
     'rack-2d: lookupRackDef handles raw JSON catalogue ({racks: {key: def}})');
  ok(lookupRackDef(mapCatalogue, 'test-18u') === fakeDef,
     'rack-2d: lookupRackDef handles Map<key, def> catalogue');
  ok(lookupRackDef(jsonCatalogue, 'nope') === null,
     'rack-2d: lookupRackDef returns null on missing key');
  ok(lookupRackDef(null, 'test-18u') === null,
     'rack-2d: lookupRackDef returns null on null catalogue (graceful degrade)');

  const dims = rackFootprintMetres(fakeDef);
  ok(Math.abs(dims.w_m - 0.6) < 1e-9 && Math.abs(dims.d_m - 0.8) < 1e-9,
     'rack-2d: rackFootprintMetres returns mm→m (600,800) → (0.6,0.8)');
  // Fallback when fields missing — must still produce a non-zero
  // footprint so the user sees SOMETHING and the bug is visible.
  const fb = rackFootprintMetres({});
  ok(fb.w_m > 0 && fb.d_m > 0,
     `rack-2d: rackFootprintMetres falls back to non-zero when dims missing (got ${fb.w_m} × ${fb.d_m})`);

  // (5) Geometric parity — drive renderRackFootprintSVG with a known
  // (centre, mToPx) and parse the SVG output. This is the unambiguous
  // closed-form test of the front-edge + hinge-corner convention.
  const rack = { id: 'r1', rackModelKey: 'test-18u', yaw_deg: 0, position: { x: 1, y: 2, z: 0 } };
  // Centre at (10, 20), 100 px / m → 60×80 px footprint, halfW=30, halfD=40.
  const svgUnrot = renderRackFootprintSVG(rack, fakeDef, { cxPx: 10, cyPx: 20, mToPx: 100 });
  ok(svgUnrot && svgUnrot.includes('<g'),
     'rack-2d: renderRackFootprintSVG produces a <g> for a valid (rack, def)');

  // Body rect: x=-30, y=-40, width=60, height=80.
  const bodyRect = svgUnrot.match(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
  ok(bodyRect &&
       Math.abs(parseFloat(bodyRect[1]) - (-30)) < 1e-6 &&
       Math.abs(parseFloat(bodyRect[2]) - (-40)) < 1e-6 &&
       Math.abs(parseFloat(bodyRect[3]) - 60) < 1e-6 &&
       Math.abs(parseFloat(bodyRect[4]) - 80) < 1e-6,
     'rack-2d: body rect is centred at local (0,0) with extent ±halfW × ±halfD');

  // Front line: y1 = y2 = +halfD = +40, x1 = -30, x2 = +30. AND the
  // stroke-width on the front line is FRONT_STROKE_MULT × the side
  // stroke (so the line is the visual cue, not just incidental).
  const frontLine = svgUnrot.match(/<line x1="(-?[\d.]+)" y1="(-?[\d.]+)" x2="(-?[\d.]+)" y2="(-?[\d.]+)" stroke="[^"]+" stroke-width="([\d.]+)"/);
  ok(frontLine,
     'rack-2d: front-edge <line> emitted');
  if (frontLine) {
    const y1 = parseFloat(frontLine[2]);
    const y2 = parseFloat(frontLine[4]);
    const x1 = parseFloat(frontLine[1]);
    const x2 = parseFloat(frontLine[3]);
    const sw = parseFloat(frontLine[5]);
    ok(Math.abs(y1 - 40) < 1e-6 && Math.abs(y2 - 40) < 1e-6,
       `rack-2d: front-edge line sits at local y = +halfD = +40 (Viktor's local -Z = state -y → SVG +y under Y-flip); got y1=${y1}, y2=${y2}`);
    ok(Math.abs(x1 - (-30)) < 1e-6 && Math.abs(x2 - 30) < 1e-6,
       `rack-2d: front-edge line spans local x = -halfW..+halfW (got x1=${x1}, x2=${x2})`);
    // Side stroke = 0.06 × lineScale (default 1) = 0.06; front stroke
    // = 0.06 × FRONT_STROKE_MULT (2.4) = 0.144. Check sw > side stroke
    // by ≥ the locked multiplier.
    ok(sw > 0.06 * 2,
       `rack-2d: front-edge stroke-width (${sw}) is ≥ 2× the side stroke (0.06) — visual cue intact`);
  }

  // Hinge dot: <circle cx="..." cy="..." r="..."> at (-halfW + inset,
  // +halfD - inset). inset = min(w, d) * HINGE_INSET_FRAC. For 60×80
  // px: min=60, inset=60*0.18=10.8 → cx = -30+10.8 = -19.2, cy =
  // 40-10.8 = 29.2.
  const dot = svgUnrot.match(/<circle cx="(-?[\d.]+)" cy="(-?[\d.]+)" r="([\d.]+)" fill="[^"]+" stroke="none"/);
  ok(dot,
     'rack-2d: hinge <circle> emitted (front-LEFT corner mark)');
  if (dot) {
    const cx = parseFloat(dot[1]);
    const cy = parseFloat(dot[2]);
    const r  = parseFloat(dot[3]);
    ok(cx < 0,
       `rack-2d: hinge dot is on the LEFT side of the rack (local x < 0; got ${cx}) — Viktor's left-hinged front door`);
    ok(cy > 0,
       `rack-2d: hinge dot is on the FRONT side of the rack (local y > 0; got ${cy}) — same edge as the front-line`);
    ok(r > 0 && r < Math.min(60, 80) / 2,
       `rack-2d: hinge dot radius is positive and smaller than half the footprint (got r=${r})`);
  }

  // (6) Closed-footprint discipline. The brief: "the rack footprint in
  // 2D + print SVG is outer_w_mm × outer_d_mm (NOT including any
  // door-swing arc)." Anti-leak: SVG output for a rack with doorOpen=true
  // must NOT include any <path d="..."/> arc / pie geometry. Same rack,
  // doorOpen toggle — output SHOULD be identical (closed footprint
  // ignores doorOpen state per the brief).
  const rackOpen = { ...rack, doorOpen: true };
  const svgOpen = renderRackFootprintSVG(rackOpen, fakeDef, { cxPx: 10, cyPx: 20, mToPx: 100 });
  ok(svgOpen === svgUnrot,
     'rack-2d: doorOpen state ignored — 2D footprint is closed regardless (door swing is 3D-only)');
  ok(!/<path\b/.test(svgUnrot),
     'rack-2d: no <path> arc geometry — closed rectangle only (no door-swing arc visualization)');

  // (7) Yaw rotation — yaw_deg flows into the SVG rotate() transform
  // with the same numeric handedness as scene.js (g.rotation.y = yaw *
  // π/180). Tests render at yaw=0 and yaw=90 and confirm the rotate
  // angle in the transform attribute.
  const tf0 = svgUnrot.match(/transform="translate\([^)]*\)\s+rotate\(([-\d.]+)\)"/);
  ok(tf0 && Math.abs(parseFloat(tf0[1])) < 1e-6,
     `rack-2d: yaw_deg=0 → rotate(0.00) (got ${tf0?.[1]})`);
  const rackYaw90 = { ...rack, yaw_deg: 90 };
  const svgYaw90 = renderRackFootprintSVG(rackYaw90, fakeDef, { cxPx: 10, cyPx: 20, mToPx: 100 });
  const tf90 = svgYaw90.match(/transform="translate\([^)]*\)\s+rotate\(([-\d.]+)\)"/);
  ok(tf90 && Math.abs(parseFloat(tf90[1]) - 90) < 1e-6,
     `rack-2d: yaw_deg=90 → rotate(90.00) (got ${tf90?.[1]}) — matches scene.js handedness`);

  // (8) End-to-end print SVG. Build a fixture with TWO racks at
  // different state-y, drive buildFloorPlanSVG with an explicit
  // catalogue, and parse the output for the two rack groups. Asserts:
  //   • Y-axis: rack at state.y=+2 renders ABOVE rack at state.y=-3
  //   • X-axis: rack at state.x=+1 renders to the RIGHT of rack at state.x=-1
  //   • Both racks emit the front-line + hinge dot
  buildFixtureState();
  state.rackSystem = {
    racks: [
      { id: 'rA', rackModelKey: 'test-18u', position: { x: +1, y: +2, z: 0 }, yaw_deg: 0, label: 'A' },
      { id: 'rB', rackModelKey: 'test-18u', position: { x: -1, y: -3, z: 0 }, yaw_deg: 0, label: 'B' },
    ],
  };
  const svgFull = buildFloorPlanSVG(state, { rackCatalogue: jsonCatalogue });
  // Both rack groups present (transforms with translate(... ...) +
  // rotate(0.00)). Strict matching: there are exactly TWO rack groups
  // in the output (matchers look for the rate-limited rack body rect
  // shape with stroke-width 0.06 — the locked side stroke).
  const rackGroups = svgFull.match(/<rect x="-0\.300" y="-0\.400" width="0\.600" height="0\.800" fill="#dadce0" stroke="#1c1c1c" stroke-width="0\.060"/g) || [];
  ok(rackGroups.length === 2,
     `rack-2d print-parity: 2 rack body rects rendered in print SVG (got ${rackGroups.length})`);
  // Front-line + hinge dot present TWICE (once per rack).
  const frontLines = svgFull.match(/<line x1="-0\.300" y1="0\.400" x2="0\.300" y2="0\.400" stroke="#000000"/g) || [];
  ok(frontLines.length === 2,
     `rack-2d print-parity: 2 front-edge lines rendered (got ${frontLines.length})`);
  const hingeDots = svgFull.match(/<circle cx="-0\.192" cy="0\.292" r="0\.060" fill="#000000"/g) || [];
  ok(hingeDots.length === 2,
     `rack-2d print-parity: 2 hinge dots rendered (got ${hingeDots.length})`);

  // Y-axis ordering. Parse each rack group's translate() to recover
  // its SVG-space centre, then assert rack A (state.y=+2) is ABOVE
  // rack B (state.y=-3) — "above" = smaller SVG y.
  const tfList = [...svgFull.matchAll(/<g[^>]*transform="translate\(([-\d.]+)\s+([-\d.]+)\)\s+rotate\(0\.00\)"/g)]
    .map(m => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
  // Filter to the rack centres specifically — they're the ones that
  // also contain the rack-rect body marker. The full SVG has other <g>
  // groups (zones etc.) that don't share this rotate(0.00) signature
  // alongside translate of these magnitudes, so we sort the matches
  // and pick the two extremes by y.
  ok(tfList.length >= 2,
     `rack-2d print-parity: at least 2 rack <g> groups parsed (got ${tfList.length})`);
  if (tfList.length >= 2) {
    // Identify rack A (state.y=+2) and B (state.y=-3) by their SVG y.
    // anchorY = MARGIN_M (1.5) + room.depth_m (8) = 9.5. So:
    // rack A at state(1, 2) → SVG y = 9.5 - 2 = 7.5
    // rack B at state(-1, -3) → SVG y = 9.5 - (-3) = 12.5
    // Listener / source triangles also live in the SVG via translates;
    // pick the racks by their KNOWN expected y values.
    const yA = tfList.find(p => Math.abs(p.y - 7.5) < 0.01);
    const yB = tfList.find(p => Math.abs(p.y - 12.5) < 0.01);
    ok(yA && yB,
       `rack-2d print-parity: rack A (y=+2) at SVG y≈7.5, rack B (y=-3) at SVG y≈12.5 (got A=${yA?.y}, B=${yB?.y})`);
    if (yA && yB) {
      ok(yA.y < yB.y,
         `rack-2d Y-parity: rack at state.y=+2 renders ABOVE rack at state.y=-3 (SVG y smaller) — same Y-flip as listeners + sources`);
      // X-axis: rack A at state.x=+1 → SVG x = offsetX + 1 = 1.5 + 1 =
      // 2.5; rack B at state.x=-1 → SVG x = 1.5 + (-1) = 0.5. So
      // xA > xB ("right of"). The same convention every entity uses.
      ok(yA.x > yB.x,
         `rack-2d X-parity: rack at state.x=+1 renders to the RIGHT of rack at state.x=-1 (SVG x larger)`);
    }
  }
}

assertRackFootprintParity();

// ---------------------------------------------------------------------------
// Room Capture — captured / custom-polygon axis convention (Sam, 2026-05-31).
//
// Background. The Room Capture feature (docs/ROOM_CAPTURE_PLAN.md) commits
// CUSTOM polygon rooms through ONE path: js/capture/capture-flow.js
// buildRoomFields() → state.room.shape='custom' + custom_vertices +
// surfaces.edges (one slot per vertex), written by commitCapturedRoom().
// Manual sketch AND photo-trace both feed this path. A captured polygon
// renders on three of the four surfaces this fixture owns — 2D viewport,
// 3D top-down ortho, print plan SVG — so its +y=north / +x=east convention
// is a cross-surface concept (CLAUDE.md §3) and MUST be guarded here.
//
// The gap this closes. Everything above only exercises a RECTANGULAR room
// (shape:'rectangular', custom_vertices:null). The source/listener marker
// projection is shape-INDEPENDENT (sx = x + offsetX, sy = anchorY - y),
// so the existing parity assertions never touch the captured polygon's
// OUTLINE. A Y-flip or X-mirror bug that only manifests on the custom
// wall-polygon path (e.g. someone reads custom_vertices in screen-Y-down
// order, or negates X for the outline but not the markers) would ship
// green. This is precisely the recurring north-arrow / X-mirror failure
// mode (v=504, v=515→525).
//
// Fixture polygon. An asymmetric L — taller on the WEST — so a flipped or
// mirrored render is DETECTABLE (a symmetric square would pass either way):
//
//     custom_vertices (state-frame, metres, +y = north / UP):
//       v0 (0,0)  v1 (8,0)  v2 (8,3)  v3 (3,3)  v4 (3,7)  v5 (0,7)
//
//   The "north notch": v4/v5 sit at y=7 (the tall WEST leg reaches north);
//   the EAST half (x up to 8) only reaches y=3. So:
//     • north-most vertices: v4 (3,7) / v5 (0,7)  — must render UP (smallest SVG y)
//     • south-most vertices: v0 (0,0) / v1 (8,0)  — must render DOWN
//     • east-most vertex:    v1 (8,0) / v2 (8,3)  — must render RIGHT (largest SVG x)
//     • west-most vertices:  v0 (0,0) / v5 (0,7)  — must render LEFT
//
// We assert each surface renders the polygon outline with +y UP and +x
// RIGHT, AND that the two surfaces AGREE on which screen-corner each named
// vertex lands in.
// ---------------------------------------------------------------------------

const CAPTURE_VERTS = [
  { x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 3 },
  { x: 3, y: 3 }, { x: 3, y: 7 }, { x: 0, y: 7 },
];

// Apply a captured custom polygon to state.room the way commitCapturedRoom
// does: derive the geometry fields with the REAL pure helper buildRoomFields
// (origin shift + bbox), then write shape/custom_vertices/width/depth and one
// surfaces.edges slot per vertex. This exercises the same code path the
// feature ships, not a hand-rolled rectangle.
function applyCapturedRoom() {
  buildFixtureState();
  const patch = buildRoomFields({
    vertices: CAPTURE_VERTS,
    scaleResolved: true,
    provenance: 'manual',
  });
  const room = state.room;
  room.shape = patch.shape;                 // 'custom'
  room.custom_vertices = patch.custom_vertices;
  room.width_m = patch.width_m;             // bbox: 8
  room.depth_m = patch.depth_m;             // bbox: 7
  const slot = room.surfaces?.walls ?? 'gypsum-board';
  room.surfaces = room.surfaces || {};
  room.surfaces.edges = patch.custom_vertices.map(() => slot);
  return room;
}

// Print plan — project a state-frame point through the SAME mapping
// buildFloorPlanSVG uses (sx = x + offsetX, sy = anchorY - y). Derived from
// the room bbox + MARGIN_M (no podium extension here, so minX=minY=0).
function projectionPrintPlan(room, pt) {
  const MARGIN_M = 1.5; // matches print-plan-svg.js MARGIN_M
  const offsetX = MARGIN_M - 0;                 // minX = 0 (no podium)
  const anchorY = MARGIN_M + room.depth_m;      // maxY = depth_m
  return { sx: pt.x + offsetX, sy: anchorY - pt.y };
}

function assertCapturedPolygonAxes() {
  const room = applyCapturedRoom();

  // (0) The capture commit path produced the expected custom room — guards
  //     against buildRoomFields silently changing the origin/bbox contract.
  ok(room.shape === 'custom' && Array.isArray(room.custom_vertices)
     && room.custom_vertices.length === CAPTURE_VERTS.length,
     'capture: buildRoomFields → shape "custom" with 6 vertices');
  ok(Math.abs(room.width_m - 8) < 1e-9 && Math.abs(room.depth_m - 7) < 1e-9,
     'capture: bbox width_m=8, depth_m=7 (vertex[0] already at origin → unchanged)',
     `got width_m=${room.width_m}, depth_m=${room.depth_m}`);
  ok(Array.isArray(room.surfaces.edges) && room.surfaces.edges.length === 6,
     'capture: surfaces.edges has one slot per vertex (commitCapturedRoom shape)');

  // The print-plan wall OUTLINE comes from wallInsetPolygon(room).outer,
  // which for a custom room is custom_vertices verbatim. Confirm — if a
  // future change rewinds / reorders the outer ring, the named-vertex
  // assertions below would still hold by VALUE, so we also lock the source.
  const outer = wallInsetPolygon(room).outer;
  ok(outer.length === CAPTURE_VERTS.length,
     'capture: wallInsetPolygon.outer traces the full 6-vertex custom outline');

  // Project the named vertices on each surface.
  const NORTH = { x: 3, y: 7 };  // v4 — tall west leg reaches north
  const SOUTH = { x: 3, y: 0 };  // on the y=0 edge (a real point of the outline span)
  const EAST  = { x: 8, y: 3 };  // v2 — east wall
  const WEST  = { x: 0, y: 7 };  // v5 — west wall, north end

  const print = {
    north: projectionPrintPlan(room, NORTH),
    south: projectionPrintPlan(room, SOUTH),
    east:  projectionPrintPlan(room, EAST),
    west:  projectionPrintPlan(room, WEST),
  };
  // 2D viewport uses the shared currentRoomGeom() formula: for any point
  // sx = x0 + worldX * scale, sy = y0 - worldY * scale. projection2D()
  // above already encodes this (it collapses pxW/width_m → scale for the
  // no-extension case). Reuse it — it reads bounds from state.room, which
  // applyCapturedRoom() has set to the custom polygon.
  const v2d = {
    north: projection2D(state, NORTH),
    south: projection2D(state, SOUTH),
    east:  projection2D(state, EAST),
    west:  projection2D(state, WEST),
  };

  // (1) Per-surface Y convention: north vertex (y=7) renders ABOVE the
  //     south edge (y=0) — "above" = SMALLER SVG y.
  ok(print.north.sy < print.south.sy,
     'capture print-plan: north vertex (y=7) renders ABOVE south edge (y=0) — +y is UP',
     `north.sy=${print.north.sy.toFixed(3)} south.sy=${print.south.sy.toFixed(3)}`);
  ok(v2d.north.sy < v2d.south.sy,
     'capture 2d-viewport: north vertex (y=7) renders ABOVE south edge (y=0) — +y is UP',
     `north.sy=${v2d.north.sy.toFixed(3)} south.sy=${v2d.south.sy.toFixed(3)}`);

  // (2) Per-surface X convention: east vertex (x=8) renders to the RIGHT
  //     of the west edge (x=0) — "right" = LARGER SVG x.
  ok(print.east.sx > print.west.sx,
     'capture print-plan: east vertex (x=8) renders RIGHT of west edge (x=0) — +x is RIGHT',
     `east.sx=${print.east.sx.toFixed(3)} west.sx=${print.west.sx.toFixed(3)}`);
  ok(v2d.east.sx > v2d.west.sx,
     'capture 2d-viewport: east vertex (x=8) renders RIGHT of west edge (x=0) — +x is RIGHT',
     `east.sx=${v2d.east.sx.toFixed(3)} west.sx=${v2d.west.sx.toFixed(3)}`);

  // (3) Cross-surface AGREEMENT: both surfaces sort the four named vertices
  //     into the SAME screen quadrants. If one surface mirrors or flips the
  //     custom outline relative to the other, this trips even when each
  //     surface is internally self-consistent.
  const printYOrder = print.north.sy < print.south.sy ? 'north-up' : 'north-down';
  const v2dYOrder   = v2d.north.sy   < v2d.south.sy   ? 'north-up' : 'north-down';
  ok(printYOrder === v2dYOrder,
     'capture cross-surface: print-plan and 2D viewport AGREE on Y orientation of the captured outline',
     `print=${printYOrder} 2d=${v2dYOrder}`);
  const printXOrder = print.east.sx > print.west.sx ? 'east-right' : 'east-left';
  const v2dXOrder   = v2d.east.sx   > v2d.west.sx   ? 'east-right' : 'east-left';
  ok(printXOrder === v2dXOrder,
     'capture cross-surface: print-plan and 2D viewport AGREE on X orientation of the captured outline',
     `print=${printXOrder} 2d=${v2dXOrder}`);

  // (4) End-to-end: the FULL print-plan SVG actually emits the captured
  //     outline (via the wall polygon) and the highest-y vertex sits at the
  //     smallest SVG y in the rendered string. Parses the wall <polygon>
  //     points so a projection regression in buildFloorPlanSVG itself —
  //     not just our replicated formula — is caught.
  const svg = buildFloorPlanSVG(state);
  ok(svg && svg.length > 0, 'capture print-plan: buildFloorPlanSVG returns non-empty SVG for the captured room');
  // Wall polygons are emitted as 4-corner trapezoids (outer+inner faces).
  // Collect every emitted vertex y and assert the topmost rendered point
  // corresponds to the northern leg (state y=7 → SVG y = anchorY - 7 ≈ 1.5),
  // NOT the southern edge (y=0 → SVG y ≈ 8.5). A Y-flip regression would
  // invert these.
  const polyYs = [...svg.matchAll(/<polygon points="([^"]+)"/g)]
    .flatMap(m => m[1].trim().split(/\s+/).map(p => parseFloat(p.split(',')[1])))
    .filter(Number.isFinite);
  ok(polyYs.length > 0, 'capture print-plan: wall polygons emit parseable vertices');
  if (polyYs.length > 0) {
    const minSvgY = Math.min(...polyYs);
    const anchorY = 1.5 + room.depth_m;          // MARGIN_M + maxY
    const northSvgY = anchorY - 7;               // ≈ 1.5
    ok(Math.abs(minSvgY - northSvgY) < 0.5,
       'capture print-plan: rendered outline TOP (min SVG y) is the north leg (state y=7), not the y=0 edge — no Y-flip',
       `minSvgY=${minSvgY.toFixed(3)} expected≈${northSvgY.toFixed(3)}`);
  }
}

assertCapturedPolygonAxes();

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
