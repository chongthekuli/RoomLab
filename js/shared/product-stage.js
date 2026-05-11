// Shared product-preview stage rig — used by SpeakerLAB AND SurfaceLAB.
// Viktor's "commercial-grade" spec (Oct 2026, post-morgue-lighting
// complaint): warm 3-light studio rig with PBR env map for actual
// reflections, walnut-veneer disc stage, soft radial contact shadow,
// vertical gradient cyc background, AgX tone mapping, auto-fit framing
// per product so a tall narrow speaker AND a flat square panel both
// fill the viewport without per-product tweaks.
//
// Performance budget: ~0.9 ms/frame desktop iGPU, ~1.4 ms mobile.
// PMREM environment map generated ONCE on first call and cached at
// module scope across both Labs.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

let _envMap = null;
let _walnutTex = null;
let _shadowTex = null;

const MOBILE = (typeof navigator !== 'undefined') && (
  ((navigator.deviceMemory ?? 8) < 4) ||
  (window.devicePixelRatio > 2 && window.innerWidth < 900)
);

// ---------------------------------------------------------------------
// createStudioRig — sets renderer post-processing + lights + env map
// ---------------------------------------------------------------------

export function createStudioRig(renderer, scene) {
  // Tone mapping + colour space. AgX was added in r160; fall back to
  // ACES if the build is older.
  renderer.toneMapping = (THREE.AgXToneMapping != null) ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Environment map — lit-shading reflections only. NEVER set as
  // scene.background (the gradient backdrop is the visible bg).
  if (!_envMap) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = new RoomEnvironment();
    _envMap = pmrem.fromScene(env, 0.04).texture;
    pmrem.dispose();
    if (env.dispose) env.dispose();
  }
  scene.environment = _envMap;

  // Key — warm front-top (4200 K). Shadow-casting; this is the only
  // light that needs a shadow map.
  const key = new THREE.DirectionalLight(0xfff4e6, 2.6);
  key.position.set(2.2, 3.4, 2.0);
  key.castShadow = true;
  const shadowRes = MOBILE ? 512 : 1024;
  key.shadow.mapSize.set(shadowRes, shadowRes);
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 8;
  key.shadow.camera.left = -1.5;
  key.shadow.camera.right = 1.5;
  key.shadow.camera.top = 1.8;
  key.shadow.camera.bottom = -0.5;
  key.shadow.bias = -0.0005;
  key.shadow.radius = 4;
  scene.add(key);

  // Fill — cool sky-bounce (6500 K) from opposite quadrant.
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.9);
  fill.position.set(-2.6, 1.4, 1.2);
  scene.add(fill);

  // Rim — warm kicker from behind/above, separates silhouette from bg.
  const rim = new THREE.DirectionalLight(0xffd8b0, 1.4);
  rim.position.set(-0.8, 2.0, -2.4);
  scene.add(rim);

  return { key, fill, rim };
}

// ---------------------------------------------------------------------
// createStage — gradient background + walnut disc + contact shadow
// ---------------------------------------------------------------------

export function createStage(scene) {
  // Vertical gradient background (studio-cyc style).
  scene.background = makeGradientBackground();

  // Walnut veneer disc — 1.1 m diameter, 4 cm thick. Top surface at y=0.
  const tex = ensureWalnutTexture();
  const stageMat = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.55,
    metalness: 0.0,
    envMapIntensity: 0.6,
  });
  const stage = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.55, 0.04, 96),
    stageMat,
  );
  stage.position.y = -0.02;
  stage.receiveShadow = true;
  scene.add(stage);

  // Soft radial contact shadow — Apple-page trick. Plane just above
  // the stage surface, alpha-blended dark gradient. Skipped on mobile
  // to stay within the perf budget.
  let shadowMesh = null;
  if (!MOBILE) {
    const shadowTex = ensureContactShadowTexture();
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    shadowMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), shadowMat);
    shadowMesh.rotation.x = -Math.PI / 2;
    shadowMesh.position.y = 0.001;
    scene.add(shadowMesh);
  }

  return { stage, shadowMesh };
}

// ---------------------------------------------------------------------
// applyAutoFit — recenters product on stage + frames camera to bbox
// ---------------------------------------------------------------------

export function applyAutoFit(camera, controls, group, { padding = 1.6 } = {}) {
  group.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(group);
  if (bbox.isEmpty()) return;

  const center = new THREE.Vector3();
  bbox.getCenter(center);
  const size = new THREE.Vector3();
  bbox.getSize(size);

  // Recenter X/Z; place bottom of product on the stage surface (y=0).
  group.position.x -= center.x;
  group.position.z -= center.z;
  group.position.y -= bbox.min.y - 0.001;

  // Re-measure after recenter so camera framing uses corrected coords.
  group.updateMatrixWorld(true);
  const bbox2 = new THREE.Box3().setFromObject(group);
  const center2 = new THREE.Vector3();
  bbox2.getCenter(center2);
  const size2 = new THREE.Vector3();
  bbox2.getSize(size2);

  // Camera framing — canonical 3/4 product angle.
  const fovRad = camera.fov * Math.PI / 180;
  const maxDim = Math.max(size2.x, size2.y * 1.1, size2.z);
  const dist = ((maxDim * 0.5) / Math.tan(fovRad / 2)) * padding;
  const az = 28 * Math.PI / 180;     // azimuth off Z axis
  const el = 14 * Math.PI / 180;     // elevation above stage

  const target = new THREE.Vector3(0, bbox2.min.y + size2.y * 0.45, 0);
  camera.position.set(
    target.x + dist * Math.cos(el) * Math.sin(az),
    target.y + dist * Math.sin(el),
    target.z + dist * Math.cos(el) * Math.cos(az),
  );
  camera.lookAt(target);

  if (controls) {
    controls.target.copy(target);
    controls.minDistance = dist * 0.5;
    controls.maxDistance = dist * 2.5;
    controls.update();
  }
}

// Apply cast/receive shadows to every Mesh in a group. Call once per
// product after building, before applyAutoFit. Cheap (one tree walk).
export function applyShadowFlags(group) {
  group.traverse(obj => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = false;          // products receive env light + key, not their own shadow
    }
  });
}

// ---------------------------------------------------------------------
// Texture builders (procedural, cached at module scope)
// ---------------------------------------------------------------------

function makeGradientBackground() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.00, '#3a3f47');      // top — warm graphite
  grad.addColorStop(0.55, '#1f2329');      // mid — slight roll-off
  grad.addColorStop(1.00, '#15171a');      // bottom — near-black, blends into shadow
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

function ensureWalnutTexture() {
  if (_walnutTex) return _walnutTex;
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1024;
  const ctx = c.getContext('2d');

  // Base — warm walnut mid-tone.
  ctx.fillStyle = '#8a6a4a';
  ctx.fillRect(0, 0, 1024, 1024);

  // 8 sinusoidal grain bands at varied frequency, opacity, vertical offset.
  for (let i = 0; i < 8; i++) {
    const opacity = 0.10 + Math.random() * 0.14;
    const freq = 50 + Math.random() * 90;
    const yOff = (i * 128) + Math.random() * 80;
    const warpAmp = 4 + Math.random() * 8;
    const tone = (Math.random() < 0.5) ? '#3a2818' : '#5a3a22';
    ctx.strokeStyle = hexToRgba(tone, opacity);
    ctx.lineWidth = 0.6 + Math.random() * 1.5;
    ctx.beginPath();
    for (let x = 0; x <= 1024; x += 3) {
      const y = yOff + Math.sin((x / freq) * Math.PI * 2) * warpAmp + Math.sin(x / 200) * 5;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Subtle blotchy darker patches — like real walnut.
  for (let i = 0; i < 12; i++) {
    const x = Math.random() * 1024;
    const y = Math.random() * 1024;
    const r = 30 + Math.random() * 60;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(40, 24, 14, 0.18)');
    grad.addColorStop(1, 'rgba(40, 24, 14, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Final noise pass — micro-roughness.
  ctx.globalAlpha = 0.05;
  for (let i = 0; i < 4000; i++) {
    const x = Math.random() * 1024;
    const y = Math.random() * 1024;
    ctx.fillStyle = Math.random() < 0.5 ? '#000000' : '#ffffff';
    ctx.fillRect(x, y, 1, 1);
  }
  ctx.globalAlpha = 1;

  _walnutTex = new THREE.CanvasTexture(c);
  _walnutTex.colorSpace = THREE.SRGBColorSpace;
  _walnutTex.wrapS = _walnutTex.wrapT = THREE.RepeatWrapping;
  _walnutTex.anisotropy = 8;
  return _walnutTex;
}

function ensureContactShadowTexture() {
  if (_shadowTex) return _shadowTex;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0.00, 'rgba(0, 0, 0, 0.72)');
  grad.addColorStop(0.35, 'rgba(0, 0, 0, 0.42)');
  grad.addColorStop(0.70, 'rgba(0, 0, 0, 0.10)');
  grad.addColorStop(1.00, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  _shadowTex = new THREE.CanvasTexture(c);
  _shadowTex.colorSpace = THREE.SRGBColorSpace;
  return _shadowTex;
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
