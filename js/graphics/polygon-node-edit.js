// Pure polygon-vertex edit helpers for the 2D viewport's custom-room
// "node" context menu (right-click a vertex → Add node / Delete node).
//
// These are DOM-free and Three.js-free so they load + unit-test under
// plain Node (`tests/polygon-node-edit.test.mjs`). room-2d.js imports
// them for the live menu. Coordinates are world metres `{ x, y }`.
//
// Contract:
//   insertMidpointNode(verts, idx, snapFn) → NEW array (input untouched),
//     a vertex spliced in at idx+1 at the midpoint of edge idx→idx+1
//     (wrap last→first), snapped via snapFn. Winding order preserved.
//   deleteNode(verts, idx) → NEW array, or null if removing would drop
//     below the 3-vertex polygon floor (or idx is out of range).
//   fixSelectionAfterDelete(selected, deletedIdx, newLen) → the corrected
//     selectedVertexIdx after a delete (clears when the selected vertex
//     was the deleted one; shifts down when it sat above; clamps to range).

// Default snap: identity. room-2d.js passes its 0.5 m grid snapper.
const identity = (v) => v;

export function insertMidpointNode(verts, idx, snapFn = identity) {
  if (!Array.isArray(verts) || verts.length < 1) return verts;
  if (!Number.isInteger(idx) || idx < 0 || idx >= verts.length) return verts;
  const a = verts[idx];
  const b = verts[(idx + 1) % verts.length];
  const mid = {
    x: snapFn((a.x + b.x) / 2),
    y: snapFn((a.y + b.y) / 2),
  };
  const out = verts.slice();
  out.splice(idx + 1, 0, mid);
  return out;
}

export function deleteNode(verts, idx) {
  if (!Array.isArray(verts) || verts.length <= 3) return null;
  if (!Number.isInteger(idx) || idx < 0 || idx >= verts.length) return null;
  const out = verts.slice();
  out.splice(idx, 1);
  return out;
}

export function fixSelectionAfterDelete(selected, deletedIdx, len) {
  if (selected == null) return null;
  if (selected === deletedIdx) return null;
  const next = selected > deletedIdx ? selected - 1 : selected;
  if (next < 0 || next >= len) return null;
  return next;
}
