# custom-room drawing UX — design spec

Author: Maya Okafor. Target file scope: `js/graphics/room-2d.js`, `js/ui/panel-room.js`, plus a new `js/graphics/room-3d-vertex-handles.js` stub.

## 1. diagnosis — what's wrong today

Observable failures in the current draw flow (`room-2d.js:51-72`, `199-214`, `269-283`):

- **the toolbar lies about how to finish.** copy reads `click to add vertex · double-click to close · N placed`. there is no auto-close-on-near-first; the only finish paths are the `Finish` button and dblclick. a pro draws a 6-sided room, hovers near point 1 expecting the snap, and nothing happens.
- **origin is invisible until draw starts.** `renderNormal` (`room-2d.js:295-373`) shows a heatmap floor; the `0,0` glyph at `(x0-8, y0-8)` only appears inside `renderCustomDraw`. user has no idea where they are about to place point 1.
- **0.1 m grid snap is the wrong tool.** `drawCoordsFromEvent` rounds to one decimal (`room-2d.js:157`). a 12.4 m × 8.7 m room is fiction; pros work to 0.5 m (façade modules, seat rows, structural bays). 0.1 m is "feels precise", not "is useful".
- **grid is monotone.** the `<pattern>` block (`room-2d.js:202-204`) draws every 1 m line at the same `#2a2f38 / 0.5 px`. no major/minor distinction. user can't count bays at a glance.
- **first-click cursor preview is a 4 px yellow ring with two-decimal coords.** at 0.5 m snap, two decimals are noise. and the ring doesn't show what the placed vertex would look like — no shape consistency between hover and click.
- **height never gets prompted.** finishing the draw drops the user back into the side panel with `state.room.height_m` still at whatever it was (default 4 m on rectangular). spec point 4 needs an in-flow ask, not a hope-they-find-the-input.
- **vertex-list editor is functional but ugly.** `panel-room.js:300-340` — three-column row, X and Y inputs same width, no axis hint, delete button only when `> 3`. fine. but no way to know which row maps to which corner on the canvas without counting.
- **no 3D vertex handles**, no 3D face-pick affordance, no "here is what you click next" coaching. the flow ends at `state.room.shape = 'custom'` and the user is on their own.

## 2. drawing-mode panel-canvas spec

Top guide-text band — a single line, **#cfd6e0 11 pt sentence-case, 12 px line-height**, sits on a `#13161c` band 32 px tall above the canvas. Replaces the current `.draw-hint` span and absorbs the placed-count.

State copy (exact strings, lower-case):

| state | copy |
|---|---|
| 0 vertices placed | `click on the grid to place point 1. press esc to cancel.` |
| 1 placed | `click to add point 2. snap is 0.5 m.` |
| 2 placed | `click to add point 3. you'll need at least 3 to close a polygon.` |
| ≥ 3 placed, cursor far from p1 | `click to add point N+1. double-click to finish, or click point 1 to close.` |
| ≥ 3 placed, cursor within 0.6 m of p1 | `release here to close the loop — N edges.` |
| invalid (self-intersecting next edge) | `that edge crosses an existing edge. pick a different point.` (red band, `#c64545`) |

Origin crosshair — drawn at `(CUSTOM_ORIGIN.x, CUSTOM_ORIGIN.y)` whether or not draw is active. 14 px stroke length each arm, 1 px `#7a89a0`, 4 px gap at centre. label `0.0, 0.0 m` at offset `(+8, -10)`, 10 pt `#7a89a0`. **Always visible**, including in `renderNormal` so the user sees where world-origin is on the heatmap.

Snap visual feedback — cursor ghost is a **6 px filled circle, `#4a8ff0` at 50 % opacity, white 1.5 px ring**. Same geometry as a placed vertex but transparent. coord readout below the ghost: `x.x, y.y m`, **one decimal only** (because snap is 0.5 m, that's all the precision that exists). Snap-grid hint: when the cursor is within 4 px of a 0.5 m intersection, a 12 px square outline pulses at the snap target — `#ffd000 1 px stroke, 200 ms ease-out scale 1 → 1.1 → 1`. one pulse, not a loop.

Auto-close visual feedback — when `≥ 3` vertices are placed and the cursor is within **0.6 m of vertex 1**:
- vertex 1 dot grows from `r=6` to `r=10`, fill stays `#4a8ff0`, stroke widens to 3 px white.
- the dashed preview line stops snapping to the cursor and snaps to vertex 1.
- the closing dashed line (the "back to start" preview, `room-2d.js:253-254`) becomes a solid 2.5 px stroke at full opacity, signalling commit.
- click anywhere within that 0.6 m radius commits as if the user clicked vertex 1 exactly. **do not require pixel-perfect accuracy.**

Cancel / undo / done affordances — keep the existing buttons but relabel:
- `Undo` → `undo last point` (disabled at 0 vertices)
- `Finish` → `finish (N pts)` — disabled `< 3`
- `Cancel` → `cancel`
- add keyboard: `Esc` cancels, `Backspace` undoes last point, `Enter` finishes if `≥ 3`. wire on the SVG element via `tabindex="0"` and an `addEventListener('keydown')` in `wireDrawEvents`.

## 3. 0.5 m grid spec

Replace the single-pattern grid (`room-2d.js:202-204`) with two stacked patterns:

```
minor: 0.5 m × 0.5 m  →  20 px × 20 px (CUSTOM_SCALE = 40 px/m)
       stroke  #1f242c   width 0.5 px

major: 5.0 m × 5.0 m  →  200 px × 200 px
       stroke  #2f3744   width 1 px
```

Render minor first, major on top. Add 5 m tick labels (`5 m`, `10 m`, …) along the top edge and the left edge in 9 pt `#5a6677`, only on major lines. Suppress the label at `0,0` (the crosshair already says it).

Snap rounding: change `Math.round(rx * 10) / 10` to `Math.round(rx * 2) / 2` in `drawCoordsFromEvent` (`room-2d.js:157`). Also widen the visible coord readout to one decimal (`drawCursor.rx.toFixed(1)`).

## 4. origin-positioning UX

Pro convention: **drag-pan the canvas, don't drag the marker.** Reasons: (a) the origin in state terms is whatever the user clicks first, so moving the marker is a UI-only viewport offset and pretending it's anything more confuses people; (b) numeric origin inputs are bureaucratic for a placement task that takes 2 seconds.

Spec:

- **middle-mouse-drag or `space + left-drag` pans** the canvas. pan offset is a viewport variable (`drawViewportOffset = {dx, dy}`) added to `CUSTOM_ORIGIN` at render time. not in `state.room`.
- **double-click on empty canvas (no vertices placed)** resets pan to `(0, 0)` so the origin returns to its default 60, 60 inset.
- **a small `recentre` button** (icon-only, 24 × 24, top-right of the canvas band) resets pan. tooltip: `recentre origin (double-click empty canvas)`.

This is the simplest pattern that matches CAD muscle memory. Do not add numeric origin inputs. Do not let the user drag the origin marker itself — the marker is a label, not a handle.

## 5. post-draw vertex-editing UX

**side panel — delta on `panel-room.js:300-340`:**

- left-align the row, replace the bare `1` index with a coloured chip matching the vertex dot fill (`#4a8ff0`, 18 × 18, white text, 11 pt). same chip is rendered on the 2D canvas next to the dot so the user can scan-match.
- inputs gain a unit suffix: `<input> <span class="unit">m</span>`, x-input first, y-input second, both 64 px wide. add `aria-label="vertex N x metres"` etc.
- on row hover, highlight the matching vertex on the 2D and 3D canvas (emit `vertex:hover` with `idx`, both viewports listen).
- on row focus, scroll the 2D viewport so the vertex is centred and pulse it once.

**2D viewport drag handles** — vertex circles already render at `r=6`. add:

- mousedown on a vertex enters drag mode. cursor becomes `grabbing`. while dragging, the vertex follows the cursor snapped to 0.5 m. live-update `state.room.custom_vertices[i]` and emit `room:changed`. on mouseup, commit (no undo stack v1).
- visual states (all on the same `<circle>`):
  - **regular**: `fill #4a8ff0, stroke #ffffff 2 px`
  - **hovered**: `fill #6aa8ff, stroke #ffffff 2.5 px, r=8`
  - **selected** (mousedown active): `fill #ffd000, stroke #ffffff 3 px, r=9`
- right-click on a vertex → context menu (small absolute-positioned `<div>`, not a `<dialog>`): `insert vertex before · insert vertex after · delete vertex`. position next to the cursor; dismiss on outside-click or `Esc`.

**3D viewport drag handles** — out of scope to fully implement today, but the hook:

- ship a `js/graphics/room-3d-vertex-handles.js` with `mountVertexHandles(scene, camera, renderer)`. for v1, render a small floor-plane sphere (`SphereGeometry r=0.15 m, MeshBasicMaterial #4a8ff0`) at every `state.room.custom_vertices[i]` projected to floor `y=0`.
- raycast on pointerdown; if hit, lock the drag to the floor plane (`y=0` always — no vertical motion). the corner pulls along the floor only. emit `vertex:drag` with `{idx, x, y}`, snap 0.5 m, commit on pointerup with `room:changed`.
- the wall above the vertex re-extrudes from the new corner. ceiling re-tiles automatically.
- same regular / hover / selected colours as 2D.

## 6. material-picker UX hooks

Pattern: **inline side-panel sub-section, not a floating popover, not a modal.**

When the user pointer-clicks a wall face / floor / ceiling in the 3D view, scroll the room panel to the relevant material `<select>` and pulse it (`outline 2 px solid #ffd000` for 800 ms ease-out). Open the native `<select>` programmatically via `.focus()` + `.click()` — pro users don't need a custom dropdown, the OS one is faster and keyboard-driven.

For the wall case specifically: the 3D click identifies which `surfaces.edges[i]` it is and pulses the matching `Edge i+1` row in `renderSurfaceMaterials` (`panel-room.js:440-449`). add a small `picked from 3D` flag indicator (8 px `#ffd000` dot left of the label) that fades after 2 seconds.

No floating panel. No anchored popover. The material pickers already exist and live in a known place — teach the user where they are by pulsing them, not by duplicating them.

## 7. refusals — do not ship

- **no modal "set room height" dialog.** after auto-close, scroll the side panel to the existing `height_m` input, focus it, select-all the value. one keystroke replaces it. modal would block the user from looking at the floor plan they just drew.
- **no glassmorphism.** the guide band, picker pulses, and crosshair are flat colours on flat backgrounds. blur filters cost gpu and read as illegible at 4.5:1 contrast.
- **no toast confirmations** ("vertex added!", "shape closed!"). placing a dot IS the confirmation. a 200 ms vertex pulse on close is enough.
- **no "are you sure?" on cancel.** undo recovers the work; cancel discards the in-progress draw, which has no other consumer. modals on non-destructive actions train users to dismiss without reading.
- **no autocorrect on the X/Y inputs.** if a user types `12.37`, store `12.37`. the snap is a drawing-time aid, not a data constraint.
- **no "draw mode tutorial overlay" on first use.** the guide-text band IS the tutorial. if it can't teach the flow in one line, the flow is broken — fix the flow.

## 8. one thing engineering must not cut

**The auto-close-on-near-first behaviour with the highlighted vertex 1 and the solidified preview edge.** Spec point 1 is the entire reason this round exists. If everything else slips — keep the 0.1 m snap, ship the monotone grid, defer 3D handles — the auto-close still has to land. Without it the user double-clicks-to-finish and the polygon's last edge is wherever the cursor happened to be, which is the bug they reported.

The second-most-important piece, if you have an hour left after that, is the **always-visible origin crosshair** in normal mode (not just draw mode). Pros need to know the world origin before they decide where to click first.
