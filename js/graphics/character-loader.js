import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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

  // --- Animation mixer + clip lookup ---
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const clips = gltf.animations || [];
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
  // treats +Z as character-forward. If the head bone is on the −Z side of
  // the bbox center, rotate the INNER scene 180°. Fix the model, not the
  // controller — keeps the controller contract stable across different
  // model sources (Mixamo, RPM, Quaternius all face different directions).
  const headBone = findHeadBone(gltf.scene);
  if (headBone) {
    const headWorld = new THREE.Vector3();
    headBone.getWorldPosition(headWorld);
    const center = new THREE.Vector3();
    new THREE.Box3().setFromObject(gltf.scene).getCenter(center);
    if (headWorld.z < center.z) gltf.scene.rotation.y = Math.PI;
  }

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

// Promise wrapper around the callback-style GLTFLoader.
function loadGLB(url) {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      gltf => resolve(gltf),
      undefined, // onProgress — ignored
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

// Find the head bone for orientation detection. Covers the common Mixamo /
// Unity / VRoid bone naming conventions.
function findHeadBone(root) {
  const patterns = [/head/i, /mixamorig.*head/i];
  let hit = null;
  root.traverse(n => {
    if (hit) return;
    if (n.isBone && patterns.some(p => p.test(n.name))) hit = n;
  });
  return hit;
}
