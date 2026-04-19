# Character models

The Walkthrough mode loads `hitman.glb` from this directory at startup. If the
file is missing or fails to parse, the app automatically falls back to the
procedural suited-man avatar, so nothing breaks.

## Expected file

- **Path:** `assets/models/hitman.glb`
- **Format:** binary glTF 2.0 (`.glb`), one file, no external textures
- **Rig:** humanoid skeleton (Mixamo export works out of the box)
- **Animations baked into the clip list, named to include one of these tokens
  (case-insensitive):**
  - `idle` — plays when the character is standing still
  - `walk` — plays when moving at normal speed
  - `run`  — plays when Shift is held (optional; falls back to `walk`)

The loader matches clip names by substring, so `"Mixamo_Idle"`, `"idle_loop"`,
`"HumanIdle"` all resolve correctly.

## Scaling

The loader measures the model's bounding box and rescales so the standing
height is exactly 1.78 m, regardless of the export units. The character will
always match the arena physics (step height, stair climb, collision radius).

## Orientation

The loader checks the model's forward direction. Mixamo / most DCC tools
export characters facing −Z. RoomLAB's ThirdPersonController treats +Z as
character-forward, so the loader applies a 180° yaw offset if needed.

## Free models that work

If you don't have a custom `hitman.glb` yet, these CC0 / permissive sources
have rigged humanoids with the right animations:

- **Mixamo** (Adobe) — upload any rig, search for "Idle", "Walking", "Running"
  motion packs. Export as glTF Binary (.glb). *Requires Adobe account.*
- **Three.js examples** — `Soldier.glb` from
  `https://threejs.org/examples/models/gltf/Soldier.glb` ships with Idle,
  Walk, Run clips. CC0 / MIT compatible.
- **Ready Player Me** — export rigged humanoid avatar as GLB, then layer
  Mixamo animations on top.
- **Quaternius** — "Ultimate Character Pack" CC0 rigged humanoids.
- **Poly.pizza / Sketchfab CC0** — filter by "rigged humanoid" + "animated".

Drop the `.glb` here as `hitman.glb` and refresh the browser.
