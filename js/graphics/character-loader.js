import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// CharacterLoader — wraps THREE.GLTFLoader + AnimationMixer for the
// walkthrough avatar. Handles:
//   • Async GLB fetch with a native Promise wrapper (GLTFLoader.load uses
//     callbacks, not a native promise).
//   • Normalizing the model height to a target (default 1.78 m) by
//     measuring the skinned-mesh bounding box after animation warm-up.
//   • Setting castShadow / receiveShadow on every Mesh / SkinnedMesh so the
//     character participates in the scene's shadow pass.
//   • Detecting a clip by fuzzy name (idle / walk / run) and building
//     AnimationActions ready for crossFadeTo().
//   • Graceful failure: if the file is missing, corrupt, or CORS-blocked,
//     the returned promise rejects cleanly and the caller can keep using
//     the procedural avatar as a fallback.
//
// Usage:
//   const rig = await loadCharacterRig('assets/models/hitman.glb');
//   scene.add(rig.root);
//   // in the render loop:
//   rig.setState({ moving, running });
//   rig.update(dt);

const TARGET_HEIGHT_M = 1.78;
const CROSSFADE_SEC   = 0.2;

export async function loadCharacterRig(url, { targetHeight = TARGET_HEIGHT_M } = {}) {
  const gltf = await loadGLB(url);
  // Wrap gltf.scene in a Group so the controller moves / orients the
  // outer wrapper while the inner scene can keep a model-specific yaw
  // compensation (Mixamo faces −Z, RPM faces +Z, etc.). Hot-swappable.
  const root = new THREE.Group();
  root.add(gltf.scene);
  root.userData.tag = 'walk_avatar';

  // --- Shadow flags + SkinnedMesh niceties ---
  root.traverse(obj => {
    if (obj.isMesh || obj.isSkinnedMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      // Skinned meshes often fail default frustum tests when the skeleton
      // moves vertices outside the bind-pose AABB (three.js docs
      // recommendation). Disable so the character never pops out.
      if (obj.isSkinnedMesh) obj.frustumCulled = false;
    }
  });

  // --- Strip drift root motion per-axis from every clip ---
  // Mixamo bakes forward translation into the Hips bone, but the AXIS
  // varies by export pipeline: Blender's `export_yup=True` typically
  // keeps the keyframe data in its import frame so the "forward" axis
  // can land on Y instead of Z. Static heuristic on X/Z misses the GLB.
  //
  // Drift detection: for each axis on Hips.position, compute (last −
  // first). If |drift| > 10 cm, the axis carries monotonic translation
  // (walk forward, run forward, etc.) — replace with a constant equal
  // to the first frame so the cycle plays in place. Cyclic motions
  // (jump's vertical arc, idle bounce, crouch hip-drop) end near where
  // they started → drift small → axis preserved.
  const clips = gltf.animations || [];
  for (const clip of clips) {
    for (const track of clip.tracks) {
      if (!/Hips\.position$/i.test(track.name)) continue;
      const v = track.values;
      const N = v.length / 3;
      if (N < 2) continue;
      for (let axis = 0; axis < 3; axis++) {
        const startVal = v[axis];
        const endVal = v[(N - 1) * 3 + axis];
        if (Math.abs(endVal - startVal) > 10) {
          for (let i = 0; i < N; i++) v[i * 3 + axis] = startVal;
        }
      }
    }
  }

  // --- Animation mixer + clip lookup ---
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const actions = {};
  for (const c of clips) actions[c.name] = mixer.clipAction(c);

  // Start every action at weight 0 playing so crossFadeTo always has two
  // active actions to blend between (three.js animation-blending pattern).
  for (const a of Object.values(actions)) {
    a.play();
    a.enabled = true;
    a.setEffectiveWeight(0);
  }
  const idleAction = pickAction(actions, ['idle', 'rest', 'stand']);
  if (idleAction) idleAction.setEffectiveWeight(1);

  // --- Orientation fix (apply BEFORE scaling + plant-feet) ---
  // Use the SHOULDERS as the orientation reference: (left − right) × up
  // = forward. Robust to whichever export-axis convention the GLB shipped
  // with (Mixamo / RPM / Quaternius all face different directions).
  // Falls back to a flat 180° flip if shoulders aren't found (Mixamo
  // default convention).
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(o => { if (o.isSkinnedMesh) o.skeleton.update(); });
  const facing = detectFacing(gltf.scene);
  if (facing.z < -1e-3) gltf.scene.rotation.y = Math.PI;
  gltf.scene.updateMatrixWorld(true);

  // --- Scale + plant feet (after orientation so bbox is in final frame) ---
  const bbox = new THREE.Box3().setFromObject(gltf.scene);
  const size = new THREE.Vector3(); bbox.getSize(size);
  if (size.y > 0) {
    const scale = targetHeight / size.y;
    gltf.scene.scale.setScalar(scale);
    gltf.scene.updateMatrixWorld(true);
    const bbox2 = new THREE.Box3().setFromObject(gltf.scene);
    gltf.scene.position.y -= bbox2.min.y;   // plant feet at root y=0
  }

  return {
    root,                // outer wrapper — move / rotate this
    mixer,
    actions,
    clipNames: Object.keys(actions),
    isRigged: true,
    _current: idleAction,
    setState({ moving, running, crouching, jumping, sitting }) {
      // Priority order — most "specific" state wins. Sit beats jump beats
      // crouch beats run beats walk beats idle. Falls back to idle when a
      // requested clip isn't in the GLB.
      let target = null;
      if (sitting) {
        target = pickAction(actions, ['sit']);
      } else if (jumping) {
        target = pickAction(actions, ['jump', 'leap']);
      } else if (crouching) {
        // Single 'Crouch' clip covers both crouch-idle and crouch-walk.
        // If the GLB carries separate CrouchWalk + CrouchIdle, prefer walk
        // when moving.
        target = moving
          ? pickAction(actions, ['crouchwalk', 'crouch_walk', 'sneakwalk', 'crouch'])
          : pickAction(actions, ['crouchidle', 'crouch_idle', 'crouch']);
      } else if (running && moving) {
        target = pickAction(actions, ['run', 'jog']);
      } else if (moving) {
        target = pickAction(actions, ['walk']);
      }
      if (!target) target = pickAction(actions, ['idle', 'rest', 'stand']);
      if (!target || this._current === target) return;
      target.reset();
      target.setEffectiveTimeScale(1);
      target.setEffectiveWeight(1);
      target.enabled = true;
      target.play();
      if (this._current) this._current.crossFadeTo(target, CROSSFADE_SEC, false);
      this._current = target;
    },
    update(dt) {
      mixer.update(dt);
    },
  };
}

// Shared Draco decoder — loaded once, reused for every GLB. The decoder
// binary (~1 MB) is vendored under assets/draco/ instead of fetched from
// unpkg, so first-visit cold-cache load doesn't depend on a third-party
// CDN's responsiveness and the app works offline once the page is cached.
// If you bump the Three.js version in the importmap, refresh these files
// from `https://unpkg.com/three@<NEW>/examples/jsm/libs/draco/`.
let _dracoLoader = null;
function getDracoLoader() {
  if (_dracoLoader) return _dracoLoader;
  _dracoLoader = new DRACOLoader();
  _dracoLoader.setDecoderPath('assets/draco/');
  return _dracoLoader;
}

// Promise wrapper around the callback-style GLTFLoader. Draco decoder is
// attached so KHR_draco_mesh_compression GLBs (98%+ smaller bundles) can
// load. WebP textures (EXT_texture_webp) work natively in every modern
// browser without an extra extension handler.
function loadGLB(url) {
  const loader = new GLTFLoader();
  loader.setDRACOLoader(getDracoLoader());
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      gltf => resolve(gltf),
      undefined,
      err => reject(err),
    );
  });
}

// Find an AnimationAction whose clip name contains any of the given tokens
// (case-insensitive). Returns the FIRST match so authors can drop in clips
// named 'Idle', 'idle_loop', 'HumanIdle', etc.
function pickAction(actions, tokens) {
  for (const t of tokens) {
    const lower = t.toLowerCase();
    for (const name of Object.keys(actions)) {
      if (name.toLowerCase().includes(lower)) return actions[name];
    }
  }
  return null;
}

// Find a bone whose name matches any of the given patterns.
function findBone(root, patterns) {
  let hit = null;
  root.traverse(n => {
    if (hit) return;
    if (n.isBone && patterns.some(p => p.test(n.name))) hit = n;
  });
  return hit;
}

// Detect the character's forward direction in world space. Returns a unit
// vector — +z indicates the model already faces +Z (the controller's
// forward), −z means we need to rotate 180°.
//
// Method 1 (preferred): use shoulder bones. (left − right) × up = forward.
// Method 2 (fallback): assume Mixamo convention — model faces −Z, return
// (0, 0, −1) so the caller applies the 180° flip.
function detectFacing(root) {
  const rightShoulder = findBone(root, [
    /right.?shoulder/i, /mixamorig.*rightshoulder/i, /right.?clavicle/i,
  ]);
  const leftShoulder = findBone(root, [
    /left.?shoulder/i, /mixamorig.*leftshoulder/i, /left.?clavicle/i,
  ]);
  if (rightShoulder && leftShoulder) {
    const rWorld = new THREE.Vector3();
    const lWorld = new THREE.Vector3();
    rightShoulder.getWorldPosition(rWorld);
    leftShoulder.getWorldPosition(lWorld);
    const rightAxis = lWorld.sub(rWorld).normalize(); // points left
    // Forward is right-axis × world-up (right-handed cross). For a model
    // facing +Z with up = +Y: rightAxis = (-1,0,0), cross (0,1,0) = (0,0,1).
    const up = new THREE.Vector3(0, 1, 0);
    const forward = new THREE.Vector3().crossVectors(rightAxis, up).normalize();
    return forward;
  }
  // Fallback — Mixamo convention.
  return new THREE.Vector3(0, 0, -1);
}
