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

  // --- Strip root motion from every clip ---
  // Mixamo (and most DCC) bake forward translation into the Hips bone's
  // position track. With the controller ALSO driving the character forward,
  // the two pushes stack until the clip loops back to frame 0 — visible
  // as the "walk forward, snap back, walk forward, snap back" stutter.
  // Removing every Hips.position track makes the clip play in place; the
  // controller alone owns world-space translation. Rotation tracks on
  // Hips and every other bone are left intact so the gait still cycles.
  const clips = gltf.animations || [];
  for (const clip of clips) {
    clip.tracks = clip.tracks.filter(t => !/Hips\.position$/i.test(t.name));
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

  // --- Scale to target height ---
  // Force skeleton update so the vertex-bind-pose bbox is tight, then
  // measure + rescale. Re-measure after scaling so we can plant feet at y=0.
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(o => { if (o.isSkinnedMesh) o.skeleton.update(); });
  const bbox = new THREE.Box3().setFromObject(gltf.scene);
  const size = new THREE.Vector3(); bbox.getSize(size);
  if (size.y > 0) {
    const scale = targetHeight / size.y;
    gltf.scene.scale.setScalar(scale);
    gltf.scene.updateMatrixWorld(true);
    const bbox2 = new THREE.Box3().setFromObject(gltf.scene);
    gltf.scene.position.y -= bbox2.min.y;   // plant feet at root y=0
  }

  // --- Orientation fix ---
  // Mixamo / most DCC export facing −Z; RoomLAB's ThirdPersonController
  // treats +Z as character-forward. Rotate the INNER scene so the model
  // faces +Z. Use the SHOULDERS as the orientation reference: the vector
  // from right-shoulder to left-shoulder is reliably horizontal regardless
  // of the export-axis convention, while head-bone position swings into
  // the Y axis once Blender's `export_yup` flag is applied. Cross-product
  // (left − right) × world-up = forward; if forward.z is negative we
  // rotate 180° around Y. Falls back to a flat 180° flip when shoulders
  // aren't found (covers most Mixamo / RPM exports as a safe default).
  const facing = detectFacing(gltf.scene);
  if (facing.z < -1e-3) gltf.scene.rotation.y = Math.PI;

  return {
    root,                // outer wrapper — move / rotate this
    mixer,
    actions,
    clipNames: Object.keys(actions),
    isRigged: true,
    _current: idleAction,
    setState({ moving, running }) {
      const wantRun = running && pickAction(actions, ['run', 'jog']);
      const wantWalk = moving && !wantRun;
      const target = wantRun
        ? pickAction(actions, ['run', 'jog'])
        : wantWalk
          ? pickAction(actions, ['walk'])
          : pickAction(actions, ['idle', 'rest', 'stand']);
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

// Shared Draco decoder — loaded once, reused for every GLB. Decoder
// binary is fetched from the same unpkg CDN as Three.js itself so the
// version stays in lock-step with the importmap entry.
let _dracoLoader = null;
function getDracoLoader() {
  if (_dracoLoader) return _dracoLoader;
  _dracoLoader = new DRACOLoader();
  _dracoLoader.setDecoderPath('https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/');
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
