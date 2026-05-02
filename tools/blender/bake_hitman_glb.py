"""
RoomLab — bake Mixamo character + 6 anim FBXs into a single GLB.

PASTE INTO Blender 5.x Text Editor → Alt+P.

Reliability anchor: Blender's duplicate-name suffix (mixamo.com.NNN) preserves
FBX import order. The user imports FBXs in alphabetical filename order:
  Ch33_nonPBR.fbx  → mixamo.com       (T-pose, ≤2 frames, dropped)
  crouch.fbx       → mixamo.com.001   → Crouch
  idle.fbx         → mixamo.com.002   → Idle
  Jump.fbx         → mixamo.com.003   → Jump
  running.fbx      → mixamo.com.004   → Run
  Sitting.fbx      → mixamo.com.005   → Sit
  walking.fbx      → mixamo.com.006   → Walk

Hips-Y stats are printed AFTER rename as a sanity check. If they look wrong
the user fixes manually before exporting (no auto-swap — that's how clips
get scrambled in the first place).
"""

import bpy
import os
import re
from bpy_extras import anim_utils

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

EXPORT_PATH = r"D:\OneDrive\CCY LINKAGE\Projects\RoomLab\assets\models\hitman.glb"

# Alphabetical FBX-filename → target action name.
# Index 0 (T-pose) is dropped; remaining 6 map to .001 .. .006 in suffix order.
ALPHABETICAL_RENAME = ["Crouch", "Idle", "Jump", "Run", "Sit", "Walk"]

TPOSE_MAX_FRAMES = 2

# Expected Hips Y mean range (Mixamo metres, ~1.0 = standing).
# Used only to print a WARN — never to swap.
EXPECTED = {
    "Sit":    {"y_mean": (0.20, 0.60), "note": "lowest hips, mostly static"},
    "Crouch": {"y_mean": (0.40, 0.80), "note": "low hips, mostly static"},
    "Idle":   {"y_mean": (0.85, 1.10), "note": "standing, small bob"},
    "Walk":   {"y_mean": (0.85, 1.10), "note": "standing, small bob"},
    "Run":    {"y_mean": (0.85, 1.15), "note": "standing, larger bob"},
    "Jump":   {"y_mean": (0.70, 1.20), "note": "largest Y range"},
}

HIPS_RE = re.compile(r"mixamorig\d*:Hips")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def log(msg):
    print(f"[bake_hitman] {msg}")

def find_skinned_armature():
    """Return the one armature object that has a skinned mesh as a child."""
    candidates = []
    for obj in bpy.data.objects:
        if obj.type != "ARMATURE":
            continue
        for child in obj.children:
            if child.type == "MESH" and any(m.type == "ARMATURE" for m in child.modifiers):
                candidates.append(obj)
                break
    if not candidates:
        # Fallback: any armature with mesh children at all.
        for obj in bpy.data.objects:
            if obj.type == "ARMATURE" and any(c.type == "MESH" for c in obj.children):
                candidates.append(obj)
                break
    if not candidates:
        raise RuntimeError("No armature with a skinned mesh child found.")
    return candidates[0]

def delete_other_armatures(keep):
    """Delete all armatures except `keep`. Children of the kept arm stay."""
    to_delete = []
    for obj in list(bpy.data.objects):
        if obj.type == "ARMATURE" and obj is not keep:
            to_delete.append(obj)
            # Also gather its mesh children so we don't leave orphaned skins
            # for clips we never use.
            for child in list(obj.children):
                to_delete.append(child)
    for obj in to_delete:
        try:
            bpy.data.objects.remove(obj, do_unlink=True)
        except Exception as e:
            log(f"  WARN: could not remove {obj.name}: {e}")
    log(f"Deleted {len(to_delete)} object(s) (other armatures + their meshes).")

def action_frame_length(action):
    fr = action.frame_range
    return int(round(fr[1] - fr[0])) + 1

def iter_action_fcurves(action):
    """Yield every fcurve across every slot/layer/strip (Blender 5.x API)."""
    if not action.layers:
        return
    for layer in action.layers:
        for strip in layer.strips:
            for slot in action.slots:
                try:
                    cb = strip.channelbag(slot)
                except Exception:
                    cb = None
                if cb is None:
                    continue
                for fc in cb.fcurves:
                    yield fc

def hips_y_stats(action):
    """Return (mean, min, max, range) for Hips world-Y, or None if not found."""
    ys = []
    for fc in iter_action_fcurves(action):
        if fc.array_index != 1:  # Y channel
            continue
        if "location" not in fc.data_path:
            continue
        # data_path looks like: pose.bones["mixamorig7:Hips"].location
        if not HIPS_RE.search(fc.data_path):
            continue
        for kp in fc.keyframe_points:
            ys.append(kp.co[1])
    if not ys:
        return None
    return {
        "mean":  sum(ys) / len(ys),
        "min":   min(ys),
        "max":   max(ys),
        "range": max(ys) - min(ys),
        "n":     len(ys),
    }

def push_to_nla(arm, action, track_name):
    """Stash `action` as a strip on a new NLA track on `arm`."""
    if arm.animation_data is None:
        arm.animation_data_create()
    ad = arm.animation_data
    track = ad.nla_tracks.new()
    track.name = track_name
    # Strip start frame = action's own start (preserves timing).
    start = int(action.frame_range[0])
    strip = track.strips.new(name=track_name, start=start, action=action)
    strip.name = track_name
    track.mute = False
    return strip

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    log("=" * 70)
    log("STAGE 1 — find skinned armature, delete the other 6")
    log("=" * 70)

    main_arm = find_skinned_armature()
    log(f"Skinned armature: {main_arm.name}")
    delete_other_armatures(main_arm)

    log("")
    log("=" * 70)
    log("STAGE 2 — drop T-pose action, rename the rest by suffix order")
    log("=" * 70)

    # Sort by NAME so .001 < .002 < ... < .006 (also sorts mixamo.com first).
    all_actions = sorted(bpy.data.actions, key=lambda a: a.name)
    log(f"Actions before cleanup ({len(all_actions)}):")
    for a in all_actions:
        log(f"  {a.name:<24}  frames={action_frame_length(a)}")

    # Drop any action ≤ TPOSE_MAX_FRAMES (T-pose from character FBX).
    survivors = []
    for a in all_actions:
        if action_frame_length(a) <= TPOSE_MAX_FRAMES:
            log(f"Dropping T-pose action: {a.name} ({action_frame_length(a)} frames)")
            bpy.data.actions.remove(a, do_unlink=True)
        else:
            survivors.append(a)

    log(f"\n{len(survivors)} animation action(s) survive cleanup.")
    if len(survivors) != len(ALPHABETICAL_RENAME):
        log(
            f"WARN: expected {len(ALPHABETICAL_RENAME)} animations after T-pose drop, "
            f"got {len(survivors)}. Renaming will still proceed in suffix order; "
            f"verify the table below carefully."
        )

    # Re-sort survivors by name (suffix order) and rename.
    survivors.sort(key=lambda a: a.name)
    rename_pairs = []  # [(old_name, new_name, action)]
    for i, action in enumerate(survivors):
        if i >= len(ALPHABETICAL_RENAME):
            log(f"  SKIP rename: extra action {action.name} (no slot in mapping)")
            continue
        new_name = ALPHABETICAL_RENAME[i]
        old_name = action.name
        # Avoid collision if e.g. an old "Walk" already exists.
        if new_name in bpy.data.actions and bpy.data.actions[new_name] is not action:
            bpy.data.actions[new_name].name = f"_old_{new_name}"
        action.name = new_name
        rename_pairs.append((old_name, new_name, action))
        log(f"  {old_name:<24}  →  {new_name}")

    log("")
    log("=" * 70)
    log("STAGE 3 — push every renamed action onto NLA")
    log("=" * 70)

    # Wipe any pre-existing NLA tracks on the main armature so re-runs are idempotent.
    if main_arm.animation_data and main_arm.animation_data.nla_tracks:
        for tr in list(main_arm.animation_data.nla_tracks):
            main_arm.animation_data.nla_tracks.remove(tr)
        log("Cleared existing NLA tracks on main armature.")

    # Detach the active action so the NLA is the sole animation source at export.
    if main_arm.animation_data:
        try:
            main_arm.animation_data.action = None
        except Exception as e:
            log(f"  note: could not clear active action: {e}")
        try:
            # Blender 4.4+ slot ref — may not exist on all builds.
            main_arm.animation_data.action_slot = None
        except Exception:
            pass

    for old_name, new_name, action in rename_pairs:
        push_to_nla(main_arm, action, new_name)
        log(f"  pushed: {new_name}")

    log("")
    log("=" * 70)
    log("STAGE 4 — Hips-Y sanity check (warns only, no auto-swap)")
    log("=" * 70)

    header = f"  {'Name':<8} {'WasNamed':<22} {'Frames':>7} {'Y mean':>8} {'Y min':>8} {'Y max':>8} {'Y range':>8}  Verdict"
    log(header)
    log("  " + "-" * (len(header) - 2))

    warnings = []
    for old_name, new_name, action in rename_pairs:
        stats = hips_y_stats(action)
        frames = action_frame_length(action)
        if stats is None:
            log(f"  {new_name:<8} {old_name:<22} {frames:>7}  (no Hips fcurve found)")
            warnings.append(f"{new_name}: no Hips fcurve — can't sanity check")
            continue
        verdict = "ok"
        exp = EXPECTED.get(new_name)
        if exp is not None:
            lo, hi = exp["y_mean"]
            if not (lo <= stats["mean"] <= hi):
                verdict = f"WARN (expected {lo:.2f}..{hi:.2f}: {exp['note']})"
                warnings.append(
                    f"{new_name}: Hips Y mean {stats['mean']:.2f} outside expected "
                    f"{lo:.2f}..{hi:.2f} ({exp['note']})"
                )
        log(
            f"  {new_name:<8} {old_name:<22} {frames:>7} "
            f"{stats['mean']:>8.3f} {stats['min']:>8.3f} {stats['max']:>8.3f} "
            f"{stats['range']:>8.3f}  {verdict}"
        )

    log("")
    if warnings:
        log("!" * 70)
        log(f"!! {len(warnings)} WARNING(S) — verify before treating GLB as canonical:")
        for w in warnings:
            log(f"!!   {w}")
        log("!! GLB is still being exported. If a clip's wrong, re-import the FBXs")
        log("!! in strict alphabetical order (sort by Name in Explorer, select 1→7).")
        log("!" * 70)
    else:
        log("All Hips-Y stats fall within expected ranges. Mapping looks correct.")

    log("")
    log("=" * 70)
    log("STAGE 5 — export GLB")
    log("=" * 70)

    # Make sure the main armature is selected and active for the exporter.
    bpy.ops.object.select_all(action="DESELECT")
    main_arm.select_set(True)
    for child in main_arm.children:
        child.select_set(True)
    bpy.context.view_layer.objects.active = main_arm

    out_dir = os.path.dirname(EXPORT_PATH)
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    log(f"Exporting → {EXPORT_PATH}")
    bpy.ops.export_scene.gltf(
        filepath=EXPORT_PATH,
        export_format="GLB",
        export_yup=True,
        use_selection=True,
        export_apply=True,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_force_sampling=True,
        export_optimize_animation_size=True,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
    )

    if os.path.isfile(EXPORT_PATH):
        size_mb = os.path.getsize(EXPORT_PATH) / (1024 * 1024)
        log(f"Wrote {EXPORT_PATH}  ({size_mb:.2f} MB)")
    else:
        log(f"ERROR: export reported success but file not found at {EXPORT_PATH}")

    log("")
    log("Done. Next step (in PowerShell, outside Blender):")
    log("  gltf-transform resize / webp / draco  →  hitman.compressed.glb")


# Run unconditionally when the script is executed via Alt+P.
try:
    main()
except Exception as e:
    import traceback
    print("[bake_hitman] FATAL:")
    traceback.print_exc()
    raise
