# Custom-Room 3D Interaction Spec

Author: Viktor Lindqvist (technical art / rendering)
Target: `js/graphics/scene.js`
Pattern reuse: `onSpeakerHoverMove` / `onSpeakerPointerDown` / `onProbeMouseMove`

---

## 1. Diagnosis — current raycast pattern

`scene.js` already runs three independent raycasters off `renderer.domElement`:

- `_hoverRay` (pointermove, gates on `walkMode`) — speaker hover-emissive.
- `onSpeakerPointerDown` — sets `controls.target` for orbit-around-speaker.
- `_speakerClickRay` (click) — opens speaker workbench.
- `probeRaycaster` (mousemove, gates on `probeActive`) — surface SPL probe.

All four allocate a `THREE.Raycaster` once at module scope, recompute NDC from `getBoundingClientRect`, and use `intersectObject(group, true)`. Modal flags (`walkMode`, `probeActive`) are the cohabitation mechanism. **Use the same shape — do not invent a new pattern.**

Gap for wall-pick: the speaker raycaster targets `sourcesGroup`; the probe targets `roomGroup` but is read-only. We need a fourth handler that targets `roomGroup`, gated behind a new `wallEditMode` flag, that mutates state.

---

## 2. Tagging audit — what `rebuildRoom` puts in userData

| Branch | `userData.acoustic_material` | `userData.tag` | `userData.surface_id` |
|---|---|---|---|
| Rectangular floor (`scene.js:1672`) | not set (falls through to L1881 default → `wallsMatId` — **wrong**) | not set | not set |
| Rectangular ceiling (L1679) | not set (same fallback bug) | not set | not set |
| Rectangular walls (L1698) | yes (`surfId`) | not set | **MISSING** |
| Round cylinder (L1737) | yes (`wallsMatId`) | not set | not set |
| Custom edges (L1770) | yes (`edgeSurfId`) | not set | **MISSING** |
| Polygon segments (L1834) | yes | `'wall'` / `'wall_above_tunnel'` | **MISSING** |
| Dome cap (L1873) | yes | not set | not set |

**The L1880 fallback is a latent bug**: floor/ceiling fall through and get tagged `wallsMatId`. The probe currently reports walls' material on the floor. Fix as part of this work.

**Required new tag scheme** — every face mesh in `roomGroup` gets `userData.surface_id`, a string that maps 1:1 to `state.room.surfaces`:

- Rectangular: `'floor'`, `'ceiling'`, `'wall_north'`, `'wall_south'`, `'wall_east'`, `'wall_west'`
- Round: `'floor'`, `'ceiling'`, `'walls'`
- Polygon: `'floor'`, `'ceiling'`, `'walls'` (single shared id — all segments share `surfaces.walls`; clicking any updates the shared key)
- Custom: `'floor'`, `'ceiling'`, `'edge_0'` … `'edge_${n-1}'`
- Dome cap: `'ceiling'`

This is the SAME id namespace `roomSurfaces()` in `room-shape.js` already produces — reuse it. Lookup in the picker handler becomes `state.room.surfaces[surface_id]` for read, and a setter that writes back to the right slot (with `edge_${i}` → `surfaces.edges[i]`).

---

## 3. Click-to-pick-material spec

### Mode gating

Add a top-level toggle button in the Room panel: **"Edit surfaces"**. Sets `wallEditMode = true`, mirrors the `probeActive` setter at `scene.js:146`. Mutually exclusive with `probeActive` and `walkMode` — entering one disables the others. Cursor switches to a paint-bucket icon.

Rationale: a modifier-key approach (Alt-click) hides the affordance and breaks on touch. A modal toggle is discoverable and prevents stealing speaker clicks.

### Hover preview

Yes, wire it. Cost is one raycast/pointermove against `roomGroup` (already done by the probe — same machinery). Highlight technique: clone the existing `setSpeakerHighlight` pattern but lighter — bump `material.emissive` to `0x224466` and `emissiveIntensity` to `0.35`. Restore on hover-out exactly like `setSpeakerHighlight(group, false)`.

Frame cost: one extra raycast (~0.05 ms on a 1k-poly room), one material mutation (free). Total **<0.1 ms/frame** while hovering, zero when not in mode.

### Click → picker UI

On `pointerdown` (left button only) inside `wallEditMode`:

1. Raycast `roomGroup`, filter out `tag.startsWith('heatmap_')` (probe already does this).
2. Read `hit.object.userData.surface_id`. If absent, bail with `console.warn`.
3. Open a **floating popover** anchored at `e.clientX, e.clientY`, clamped to viewport. Size: 280×360 px. List materials from `data/materials.json` with name + a 24×24 swatch (use `getMaterialPalette(id).tint` — the same call `buildSurfaceMat` already makes, no new asset pipeline).
4. Click a material → call `setSurfaceMaterial(surface_id, materialId)` which writes state and emits `room:changed`. Existing `queueRebuild(REBUILD_ROOM | …)` at L327 handles the rebuild — **no new RAF logic needed**.
5. Outside-click or Esc closes the popover.

Why popover, not side-panel: the user's spatial attention is on the wall they just clicked. A side-panel forces their gaze across the screen; a popover keeps the click-target in peripheral vision. OrbitControls is unaffected because the popover is a sibling DOM node, not inside `renderer.domElement`.

### Coexistence

```
wallEditMode  → wall picker handles pointerdown, returns early before speaker handler
probeActive   → probe handles mousemove, no click semantics conflict
walkMode      → all of the above bail at the existing `if (walkMode) return` line
```

Add `if (wallEditMode) return;` at the top of `onSpeakerPointerDown`, `onSpeakerClick`, and `onProbeMouseMove`. Three lines.

---

## 4. Vertex-drag spec (custom rooms only)

### Handle geometry

One `THREE.SphereGeometry(0.18, 16, 12)` shared across all handles (instanced via reuse of geometry — meshes can share). `MeshBasicMaterial` with `color: 0x4aa3ff`, `depthTest: false`, `transparent: true`, `opacity: 0.9`, `renderOrder: 998`. Sphere radius 0.18 m → ≥16 px on screen at typical 8 m camera distance, satisfies touch hit-radius.

Group: new `vertexHandlesGroup` added to scene root (NOT `roomGroup` — survives room rebuilds, lifecycle managed independently). Rebuilt only when `state.room.shape` flips, vertex count changes, or `wallEditMode` toggles. Stored in module-scope `vertexHandlesGroup`.

Each handle: `userData.vertex_index = i`, `userData.handle = true`.

### Drag pipeline

```js
const _dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // y=0 floor
const _dragHit = new THREE.Vector3();
let _draggedHandle = null;

// pointerdown on handle:
controls.enabled = false;
_draggedHandle = hit.object;
_draggedHandle.scale.setScalar(1.4);
renderer.domElement.setPointerCapture(e.pointerId);

// pointermove while dragging:
_dragRay.setFromCamera(_ndc, activeCamera || camera);
_dragRay.ray.intersectPlane(_dragPlane, _dragHit);
let x = _dragHit.x, z = _dragHit.z;
if (snapEnabled) { x = Math.round(x / 0.5) * 0.5; z = Math.round(z / 0.5) * 0.5; }
state.room.custom_vertices[i] = { x, y: z };  // y in state coords = z in world
_draggedHandle.position.set(x, 0.02, z);
queueRebuild(REBUILD_ROOM | REBUILD_HEATMAP | REBUILD_AIM); // RAF-coalesced

// pointerup:
controls.enabled = true;
_draggedHandle.scale.setScalar(1);
_draggedHandle = null;
emit('room:changed'); // final canonical event for UI listeners
```

`THREE.Plane.setFromNormalAndCoplanarPoint` not strictly needed — the floor plane is constant `y=0`. `THREE.Raycaster.ray.intersectPlane(plane, target)` returns the world-space hit. **State coords mapping: `custom_vertices[i].y === world.z`** (confirmed by reading `room-shape.js` `roomPlanVertices`).

### Snap

0.5 m grid. Toggle via held Shift (Maya's pattern — confirm with her); default ON. Show snap grid as a subtle `THREE.GridHelper(20, 40, 0x4aa3ff, 0x223040)` at `y=0.001` only while dragging.

### Visual feedback

- Dragged handle: scale ×1.4, color shift to `0xffcc55` (warm amber, matches speaker-hover convention).
- Two adjacent edges: re-color the wireframe lines from `0xa0a8b4` (default) to `0xffcc55` while drag active. Already redrawn each rebuild — handled for free.
- Measurement label: small DOM div anchored screen-space at handle, showing `dx=2.5m, dy=1.0m` from drag start. One div, position-updated each frame, removed on pointerup. **Refuse a 3D `Sprite` for the label** — DOM is cheaper and crisper.

### Edge-midpoint = "split here" (OPTIONAL, v1.5)

Spec'd, not built in v1: rendering small `0.10`-radius secondary spheres at each edge midpoint with `userData.edge_index = i`, `userData.midpoint = true`. Click → splice a new vertex at that midpoint into `custom_vertices`, splice a new entry into `surfaces.edges` (default to the existing edge's material). Cost: doubles handle count; defer until v1 ships and validates.

---

## 5. Performance budget

| Item | Per-frame cost (Intel UHD 620, 1080p) |
|---|---|
| Wall-edit hover raycast (room ~50 faces) | 0.05 ms |
| Picker popover (DOM, hidden when closed) | 0 |
| Vertex handles render (8 spheres × `SphereGeometry(0.18,16,12)` = ~1500 tris total) | 0.15 ms |
| Drag raycast against `_dragPlane` (Plane intersection, no BVH walk) | 0.02 ms |
| Drag-induced `rebuildRoom` (RAF-coalesced, runs once per frame max) | dominates — currently ~3–8 ms for typical custom room. **This is the bottleneck.** |
| Total added overhead (idle, mode off) | 0 ms |
| Total added overhead (drag active) | ~4 ms / frame |

Three.js classes in play: `THREE.Raycaster`, `THREE.Plane` (set once, reused), `THREE.SphereGeometry` (shared), `THREE.MeshBasicMaterial`, `THREE.GridHelper`. No `PMREMGenerator`, no `EffectComposer` changes, no shader work.

**Memory discipline**: the existing `disposeGroup(roomGroup)` at L1637 catches the rebuilt room. `vertexHandlesGroup` lives outside `roomGroup` so it is NOT auto-disposed — add explicit `disposeGroup(vertexHandlesGroup)` calls in (a) `wallEditMode = false`, (b) `state.room.shape` change, (c) `scene:reset` listener. Verify with `renderer.info.memory.geometries` before/after a 30-second drag session — should return to baseline.

---

## 6. Refusals

- **No custom shader for the highlight.** Mutating `material.emissive` is what the speaker code does and it works. A shader chunk override saves no frame time and adds a maintenance liability.
- **No fake LED glow / pulsing on handles.** A static blue sphere reads as "interactive" because it's the only sphere in the scene. Pulsing is decoration, not signal.
- **No gradients in the popover swatches.** Flat tint from `getMaterialPalette(id).tint`. The user is picking a material, not admiring it.
- **No `THREE.DragControls`.** Adds a dependency, takes over pointer events globally, and fights `OrbitControls` over the same canvas. Hand-rolled drag is 30 lines and integrates with the existing modal-flag idiom.
- **No 3D `CSS2DRenderer` for the measurement label.** Plain `position: absolute` DOM is one fewer renderer to maintain.
- **No raymarched floor grid.** `THREE.GridHelper` exists, ships, costs 0.05 ms.

---

## 7. The one thing engineering MUST NOT cut

**The `userData.surface_id` tagging in `rebuildRoom`** (Section 2). Without it, both interactions become "guess from world position" hacks that misbehave on rotated walls, dome caps, and custom edges. Every other piece of this spec is rebuildable in an afternoon if the tags are present. Skip the tags and you ship a feature that works only on rectangular rooms — and we already know users will hand it custom rooms because that's the whole reason for shape `'custom'` to exist.

If scope must slip: ship wall-pick **with tags** and defer vertex-drag. Do NOT ship vertex-drag without tags.
