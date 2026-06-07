// Custom-room "node" context-menu edit regression test (v=771, 2026-06-07).
//
// Feature: right-click a polygon vertex ("node") in the 2D viewport
// (normal mode) → context menu with "Add node" / "Delete node".
//   - Add node: insert a vertex at the midpoint of the edge from this
//     node to the next (wrap last→first), snapped to the 0.5 m grid,
//     spliced at idx+1 so winding is preserved; select the new node.
//   - Delete node: remove this vertex; DISABLED at the 3-vertex polygon
//     floor; selection fixed up after removal.
//
// Both follow the SAME write path as the vertex DRAG handler — mutate
// custom_vertices → recomputeRoomDimsFromPolygon → emit('room:changed') —
// so the 3D wall builder + heatmap grid rebuild for a vertex-COUNT change
// identically to a position change. (Custom-room editing is a known
// zero-coverage area per CLAUDE.md §6.)
//
// The pure edit logic lives in js/graphics/polygon-node-edit.js (DOM-free,
// Node-loadable) and is imported + tested numerically here. The DOM wiring
// in room-2d.js (which imports ~24 browser-only modules and can't load
// under Node) is checked by static grep.
//
// Run: node tests/polygon-node-edit.test.mjs

import { readFileSync } from 'node:fs';
import {
  insertMidpointNode,
  deleteNode,
  fixSelectionAfterDelete,
} from '../js/graphics/polygon-node-edit.js';

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}
function eqArr(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v.x === b[i].x && v.y === b[i].y);
}

const snap = (v) => Math.round(v / 0.5) * 0.5; // 0.5 m grid, matches room-2d

// A unit square (CCW): the canonical custom room.
const square = () => [
  { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 },
];

// ---- 1. insertMidpointNode — midpoint math + position ----------------
{
  const v = square();
  const out = insertMidpointNode(v, 0, snap);
  ok(out.length === 5, 'insert grows the array by one');
  ok(out[1].x === 2 && out[1].y === 0, 'new node sits at midpoint of edge 0→1 (2,0)');
  ok(eqArr(v, square()), 'input array is NOT mutated (pure)');
}

// ---- 2. insert preserves winding order (spliced at idx+1) ------------
{
  const v = square();
  const out = insertMidpointNode(v, 1, snap); // edge (4,0)→(4,4) → mid (4,2)
  ok(out[2].x === 4 && out[2].y === 2, 'new node lands at idx+1 (=2), between its neighbours');
  // Original vertices keep their relative order around the splice.
  ok(out[0].x === 0 && out[3].x === 4 && out[3].y === 4,
     'surrounding vertices keep order → winding preserved');
}

// ---- 3. insert wrap-around (last → first edge) -----------------------
{
  const v = square();
  const lastIdx = v.length - 1;            // 3 → edge (0,4)→(0,0)
  const out = insertMidpointNode(v, lastIdx, snap);
  ok(out.length === 5, 'wrap insert grows the array');
  ok(out[lastIdx + 1].x === 0 && out[lastIdx + 1].y === 2,
     'wrap midpoint (last→first) = (0,2), appended at end');
}

// ---- 4. insert snaps to the 0.5 m grid -------------------------------
{
  const v = [{ x: 0, y: 0 }, { x: 1.3, y: 0 }, { x: 0, y: 4 }];
  const out = insertMidpointNode(v, 0, snap); // mid = (0.65,0) → snap (0.5,0)
  ok(out[1].x === 0.5 && out[1].y === 0, 'midpoint 0.65 snaps to 0.5 grid');
}

// ---- 5. insert out-of-range / bad input → returns input unchanged ----
{
  const v = square();
  ok(insertMidpointNode(v, 99, snap) === v, 'out-of-range idx → input returned');
  ok(insertMidpointNode(null, 0, snap) === null, 'non-array → returned as-is');
  ok(insertMidpointNode(v, -1, snap) === v, 'negative idx → input returned');
}

// ---- 6. deleteNode — happy path --------------------------------------
{
  const v = insertMidpointNode(square(), 0, snap); // 5 verts
  const out = deleteNode(v, 1);                     // drop the inserted mid
  ok(out.length === 4, 'delete shrinks the array by one');
  ok(eqArr(out, square()), 'delete removes exactly the target vertex');
  ok(v.length === 5, 'input array is NOT mutated (pure)');
}

// ---- 7. deleteNode — 3-vertex floor guard ----------------------------
{
  const tri = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 4 }];
  ok(deleteNode(tri, 0) === null, 'delete at 3 verts → null (refused, min 3)');
  ok(deleteNode(square(), 0) !== null, 'delete at 4 verts → allowed');
  ok(deleteNode([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0) === null,
     '2 verts → null (already degenerate)');
}

// ---- 8. deleteNode — out-of-range -----------------------------------
{
  ok(deleteNode(square(), 99) === null, 'delete out-of-range idx → null');
  ok(deleteNode(square(), -1) === null, 'delete negative idx → null');
}

// ---- 9. fixSelectionAfterDelete — selection stays sane ---------------
{
  // After deleting idx 1 from a 5→4 array:
  ok(fixSelectionAfterDelete(1, 1, 4) === null, 'deleting the SELECTED node clears selection');
  ok(fixSelectionAfterDelete(3, 1, 4) === 2, 'selection ABOVE deleted idx shifts down by 1');
  ok(fixSelectionAfterDelete(0, 1, 4) === 0, 'selection BELOW deleted idx is unchanged');
  ok(fixSelectionAfterDelete(null, 1, 4) === null, 'no selection → stays null');
  // Clamp: selection that would land past the new end → cleared.
  ok(fixSelectionAfterDelete(4, 4, 4) === null, 'deleting the last selected node clears');
  ok(fixSelectionAfterDelete(5, 0, 4) === null,
     'shifted selection past the new end → cleared (out-of-range guard)');
  ok(fixSelectionAfterDelete(3, 0, 4) === 2,
     'in-range shifted selection stays valid (3→2 within new len 4)');
}

// ---- 10. Static wiring grep over room-2d.js --------------------------
const src = readFileSync('./js/graphics/room-2d.js', 'utf8');

ok(/pick\.kind === 'vertex'/.test(src),
   "onPickableContextMenu has a 'vertex' branch");
ok(/function openVertexContextMenu/.test(src),
   'openVertexContextMenu builder exists');
ok(/openVertexContextMenu\(e\.clientX, e\.clientY, pick\.vertexIdx\)/.test(src),
   "vertex branch opens the node menu at the cursor");
ok(/['"]Add node['"]/.test(src), 'menu label "Add node" present (user copy)');
ok(/['"]Delete node['"]/.test(src), 'menu label "Delete node" present (user copy)');
ok(/insertMidpointNode\(cur, vertexIdx, snapToGrid\)/.test(src),
   'Add node calls insertMidpointNode with the 0.5 m grid snapper');
ok(/state\.selectedVertexIdx = vertexIdx \+ 1/.test(src),
   'Add node selects the freshly-inserted node (vertexIdx+1)');
ok(/deleteNode\(cur, vertexIdx\)/.test(src),
   'Delete node calls deleteNode');
ok(/disabled:\s*!canDelete/.test(src),
   'Delete node item is disabled at the 3-vertex floor');
ok(/const canDelete = verts\.length > 3/.test(src),
   'canDelete guard is "> 3" (min 3 nodes)');
ok(/fixSelectionAfterDelete\(\s*state\.selectedVertexIdx, vertexIdx, next\.length\)/.test(src),
   'Delete node fixes up selectedVertexIdx');

// Both actions must follow the drag write path → recompute + room:changed.
const addBlock = src.match(/action: 'add-node'[\s\S]*?\},\s*\{/);
ok(!!addBlock && /recomputeRoomDimsFromPolygon\(state\.room\)/.test(addBlock[0])
   && /emit\('room:changed'\)/.test(addBlock[0]),
   "Add node recomputes dims + emits room:changed (3D walls + heatmap rebuild)");
const delBlock = src.match(/action: 'delete-node'[\s\S]*?\},\s*\]\);/);
ok(!!delBlock && /recomputeRoomDimsFromPolygon\(state\.room\)/.test(delBlock[0])
   && /emit\('room:changed'\)/.test(delBlock[0]),
   "Delete node recomputes dims + emits room:changed");

// Custom-room-only guard in the contextmenu branch.
ok(/state\.room\?\.shape !== 'custom'/.test(src),
   'vertex menu bails gracefully for non-custom rooms');

// The generic items-menu builder exists and the legacy shim delegates to it.
ok(/function openItemsMenu/.test(src), 'generic openItemsMenu builder exists');
ok(/function openPickableMenu[\s\S]*?openItemsMenu\(clientX, clientY, label, items\)/.test(src),
   'openPickableMenu (source/listener/furniture/rack) delegates to openItemsMenu — legacy callers preserved');
ok(/is-disabled/.test(src), 'disabled items get the .is-disabled class');

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
