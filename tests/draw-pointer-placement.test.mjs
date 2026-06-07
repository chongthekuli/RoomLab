// 2D custom-draw vertex-placement regression test (v=770, 2026-06-07).
//
// Pins the fix for the "lost click" bug on fast desktop mice: draw mode
// rebuilds the entire <svg> via innerHTML on every mousemove
// (handleDrawMove → render → renderCustomDraw). A physical mouse emits a
// tiny mousemove between mousedown and mouseup; that move fires render(),
// swapping out the <svg>. The native `click` event fires only when
// mousedown and mouseup land on the SAME element, so the swap suppresses
// the click and no vertex is placed. Touch taps emit no intervening hover
// move, so the synthesized click survives — which is why phone tap was
// reliable and fast desktop mouse flaky.
//
// Fix: place vertices on pointerdown→pointerup (with a drag threshold to
// distinguish a click from a pan-drag), computing coords from the
// pointerUP event so the mid-tap rebuild no longer matters. The native
// `click` binding was removed so placement can't double-fire.
//
// Why mostly text-grep: room-2d.js imports ~24 browser-only modules and
// can't load under Node. The bug surface here is "someone re-binds
// placement to the native click" or "drops the drag-threshold / pan
// guard". A static audit guards those. The click-vs-drag decision itself
// is pulled out as a pure exported helper and re-implemented here so its
// boundary behaviour is checked numerically.
//
// Run: node tests/draw-pointer-placement.test.mjs

import { readFileSync } from 'node:fs';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

const src = readFileSync('./js/graphics/room-2d.js', 'utf8');

// ---- 1. The native `click` binding must be GONE ---------------------
// If placement is re-wired to `click`, the lost-click bug returns.
ok(!/addEventListener\(\s*['"]click['"]\s*,\s*handleDrawClick/.test(src),
   'no svgEl.addEventListener("click", handleDrawClick) (the fragile path)');
ok(!/\bhandleDrawClick\b/.test(src),
   'handleDrawClick is fully removed (no dangling reference)');

// ---- 2. Placement is bound to pointerdown + pointerup ---------------
ok(/addEventListener\(\s*['"]pointerdown['"]\s*,\s*handleDrawPlacePointerDown/.test(src),
   'pointerdown bound to handleDrawPlacePointerDown');
ok(/addEventListener\(\s*['"]pointerup['"]\s*,\s*handleDrawPlacePointerUp/.test(src),
   'pointerup bound to handleDrawPlacePointerUp');

// ---- 3. Ordering: placement pointerup BEFORE pan-end pointerup ------
// pointerup placement reads panActive; if pan-end clears it first, a
// pan-release would slip past the guard and drop a vertex.
const upPlace = src.indexOf("addEventListener('pointerup', handleDrawPlacePointerUp");
const upPanEnd = src.indexOf("addEventListener('pointerup', handleDrawPanEnd");
ok(upPlace > -1 && upPanEnd > -1 && upPlace < upPanEnd,
   'placement pointerup is registered BEFORE pan-end pointerup');

// ---- 4. Pan + drag-threshold guards are present ---------------------
ok(/function shouldPlaceVertexOnPointerUp/.test(src),
   'pure click-vs-drag decision helper exists');
ok(/if\s*\(panWasActive\)\s*return false/.test(src),
   'helper rejects placement when a pan was active');
ok(/DRAW_DRAG_THRESHOLD_PX\b/.test(src),
   'a drag-threshold constant guards click-vs-drag');
ok(/handleDrawPlacePointerDown[\s\S]*?spaceHeld[\s\S]*?return/.test(src),
   'pointerdown handler ignores pan buttons (middle / Space+left)');

// ---- 5. pointerup placement re-derives coords from its OWN event ----
// (drawCoordsFromEvent uses event.currentTarget = the live svg) so the
// rebuild during the interaction does not strand stale coordinates.
ok(/function handleDrawPlacePointerUp[\s\S]*?placeVertexFromEvent\(event\)/.test(src),
   'pointerup places from the live event, not a stale pointerdown');

// ---- 6. close-loop logic preserved in the shared placement path -----
ok(/function placeVertexFromEvent[\s\S]*?CLOSE_RADIUS_M[\s\S]*?finishDraw\(\)/.test(src),
   'placeVertexFromEvent still honours close-loop (CLOSE_RADIUS_M → finishDraw)');

// ---- 7. dblclick-to-finish strips the stray pointerup placements ----
ok(/function handleDrawDblClick[\s\S]*?DRAW_DBLCLICK_WINDOW_MS[\s\S]*?drawVertices\.pop\(\)/.test(src),
   'dblclick undoes vertices placed inside the dblclick window before finishing');

// ---- 8. lifecycle resets clear pointer bookkeeping ------------------
ok(/function resetDrawPointerState/.test(src),
   'resetDrawPointerState helper exists');
for (const site of ['cancelDraw', 'finishDraw', 'startDrawZone']) {
  const fn = src.match(new RegExp(`function ${site}[\\s\\S]*?\\n\\}`));
  ok(!!fn && /resetDrawPointerState\(\)/.test(fn[0]),
     `${site} calls resetDrawPointerState()`);
}

// ---- 9. zone-draw mode still routes through the same handlers --------
// startDrawZone sets mode 'zone'; placement handlers are mode-agnostic
// except for the room-shape-only close-loop, which is correctly guarded.
ok(/mode:\s*'zone'/.test(src), "zone draw mode still defined");
ok(/drawConfig\.mode === 'room-shape' && drawVertices\.length >= 3/.test(src),
   'close-loop is room-shape-only (zone mode unaffected)');

// ---- 10. floating-panel typed-coord path is untouched ---------------
ok(/function submitFloatCoord/.test(src) || /commitCoordPair/.test(src),
   'floating x/y coord submit path still present (separate placement path)');

// ---- 11. pure helper boundary behaviour (re-implemented mirror) -----
// Mirror of shouldPlaceVertexOnPointerUp — must stay in lockstep with the
// source. Verifies: pan → never place; sub-threshold travel → place;
// at-or-over threshold → drag, don't place.
const THRESH = 5;
function shouldPlace(down, up, panWasActive, t = THRESH) {
  if (panWasActive) return false;
  if (!down || !up) return false;
  const dx = up.clientX - down.x;
  const dy = up.clientY - down.y;
  return Math.sqrt(dx * dx + dy * dy) < t;
}
const D = { x: 100, y: 100 };
ok(shouldPlace(D, { clientX: 100, clientY: 100 }, false) === true,
   'zero travel → place (a click)');
ok(shouldPlace(D, { clientX: 103, clientY: 103 }, false) === true,
   '~4.2px travel (< 5) → place');
ok(shouldPlace(D, { clientX: 110, clientY: 100 }, false) === false,
   '10px travel → drag, no place');
ok(shouldPlace(D, { clientX: 100, clientY: 100 }, true) === false,
   'pan active → never place even with zero travel');
ok(shouldPlace(null, { clientX: 100, clientY: 100 }, false) === false,
   'missing pointerdown snapshot → no place');
ok(shouldPlace(D, { clientX: 104, clientY: 103 }, false) === false,
   '5px travel (== threshold) → drag, no place (strict <)');

// Source helper signature sanity — the exported helper's default
// threshold should be the named constant, not a magic literal.
ok(/threshold\s*=\s*DRAW_DRAG_THRESHOLD_PX/.test(src),
   'exported helper defaults threshold to DRAW_DRAG_THRESHOLD_PX');

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
