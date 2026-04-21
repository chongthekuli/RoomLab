// Small animated 3D preview of the currently-selected loudspeaker.
// Mounts a dedicated Three.js scene into the provided <canvas>. Shows
// the cabinet at scale with approximate driver placement on the front
// baffle; drivers visibly pulse to hint that the box is producing sound.
// The whole model orbits slowly so the user sees all sides without
// dragging.
//
// Similar intent to the SurroundLab "material breathing" animation —
// a visual affordance that the loaded model is what the user expects,
// before they commit to it in the scene.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let cabinetGroup = null;
let drivers = [];           // { mesh, cone, baseZ, type, pulseSpeed, pulseAmp }
let animId = null;
let lastDef = null;
let _amperesLogoTex = null;

// Module-level cache for the Amperes brand badge texture. Mirrors the
// same file the scoreboard + ceiling-cabinet use in scene.js so the
// cabinet the user sees here matches the one in the 3D viewport.
function getAmperesLogoTextureLocal() {
  if (_amperesLogoTex) return _amperesLogoTex;
  const tex = new THREE.TextureLoader().load('assets/amperes-logo.png');
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  _amperesLogoTex = tex;
  return tex;
}

export function mountSpeaker3DPreview(canvas, def) {
  if (!canvas || !def) return;
  if (lastDef === def && renderer && renderer.domElement === canvas) return;
  disposePreview();

  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  scene = new THREE.Scene();
  scene.background = null;  // transparent so the parent CSS can tint

  const aspect = width / height;
  camera = new THREE.PerspectiveCamera(28, aspect, 0.1, 20);
  camera.position.set(1.3, 0.45, 1.9);
  camera.lookAt(0, 0, 0);

  // Lighting — soft key + blueish fill + rim from behind for silhouette.
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(2.5, 3.5, 2.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x6aa0ff, 0.35);
  fill.position.set(-2, 0.8, 1.2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffcc88, 0.45);
  rim.position.set(-1.5, 1.6, -2.2);
  scene.add(rim);

  // Turntable under the speaker — subtle disk.
  const turntable = new THREE.Mesh(
    new THREE.CircleGeometry(0.7, 64),
    new THREE.MeshStandardMaterial({ color: 0x0c0f13, roughness: 0.9, metalness: 0.05 }),
  );
  turntable.rotation.x = -Math.PI / 2;
  turntable.position.y = -0.6;
  scene.add(turntable);

  cabinetGroup = buildCabinet(def);
  scene.add(cabinetGroup);

  // Frame model in the camera — compute bounding box, move camera out so it
  // fits nicely with some padding.
  fitCameraToModel(cabinetGroup, camera);

  // Orbit controls — users can drag to rotate, right-drag to pan, scroll
  // to zoom. Auto-rotate keeps the cabinet turning when the mouse is
  // idle, and pauses when the user interacts. Damping gives a natural
  // inertial feel.
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.6;
  controls.enablePan = true;
  controls.panSpeed = 0.6;
  controls.zoomSpeed = 0.9;
  // Pick sensible zoom limits from the framed camera distance.
  const initDist = camera.position.length();
  controls.minDistance = initDist * 0.4;
  controls.maxDistance = initDist * 3.5;
  // Stop auto-rotate when the user grabs the canvas — restart when they
  // let go so the model keeps showing itself off in idle.
  let userInteracting = false;
  controls.addEventListener('start', () => { userInteracting = true; controls.autoRotate = false; });
  controls.addEventListener('end', () => { userInteracting = false; setTimeout(() => { if (!userInteracting && controls) controls.autoRotate = true; }, 1500); });
  controls.update();

  lastDef = def;
  if (animId) cancelAnimationFrame(animId);
  animate();
}

export function disposePreview() {
  if (animId) { cancelAnimationFrame(animId); animId = null; }
  drivers = [];
  if (controls) { controls.dispose(); controls = null; }
  if (scene) {
    scene.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose?.();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m.dispose?.();
      }
    });
  }
  if (renderer) {
    renderer.dispose();
    renderer = null;
  }
  scene = null;
  camera = null;
  cabinetGroup = null;
  lastDef = null;
}

// Build the cabinet + drivers from the speaker definition.
function buildCabinet(def) {
  const group = new THREE.Group();
  const dim = def.physical?.dimensions_m || { w: 0.4, h: 0.6, d: 0.35 };
  const w = dim.w ?? 0.4;
  const h = dim.h ?? 0.6;
  const d = dim.d ?? 0.35;

  const isLineArray = /line-array/i.test(def.model ?? '') || /line-array/i.test(def.id ?? '');
  const isCeiling = def.mount_type === 'ceiling'
    || /ceiling/i.test(def.model ?? '')
    || /^amperes-cs/i.test(def.id ?? '');

  // Ceiling speakers are squat cylinders with a round grille on the bottom
  // (installed recessed into a ceiling tile). Render them as an upright
  // cylinder — body above, grille + driver visible on top so the user
  // can see the baffle straight on when the turntable rotates.
  if (isCeiling) return buildCeilingCabinet(group, def);

  // Cabinet body — dark, subtly metallic (matches the scene.js speaker enclosure look).
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x1a1d22, roughness: 0.55, metalness: 0.35,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bodyMat);
  group.add(body);

  // Slight edge bevel — faked with a larger dark frame around the front face.
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x0a0b0e, roughness: 0.7, metalness: 0.2,
  });
  const frameGeo = new THREE.BoxGeometry(w + 0.005, h + 0.005, 0.008);
  const frame = new THREE.Mesh(frameGeo, frameMat);
  frame.position.z = d / 2 + 0.005;
  group.add(frame);

  // Front baffle (slightly recessed).
  const baffleMat = new THREE.MeshStandardMaterial({
    color: 0x14171c, roughness: 0.8, metalness: 0.15,
  });
  const baffle = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.95, h * 0.97, 0.004),
    baffleMat,
  );
  baffle.position.z = d / 2 + 0.002;
  group.add(baffle);

  const frontZ = d / 2 + 0.01;

  if (isLineArray) {
    // Horizontal cabinet — line-array element geometry. Two LF cones
    // flanking a central HF waveguide slot.
    const coneR = Math.min(h * 0.42, w * 0.18);
    addDriver(group, -w * 0.28, 0, frontZ, coneR, 'lf');
    addDriver(group,  w * 0.28, 0, frontZ, coneR, 'lf');
    addWaveguide(group, 0, 0, frontZ, w * 0.18, h * 0.32);
  } else {
    // Vertical 2-way — LF woofer low, HF tweeter high.
    const wooferR = Math.min(w * 0.38, h * 0.28);
    addDriver(group, 0, -h * 0.18, frontZ, wooferR, 'lf');
    addDriver(group, 0,  h * 0.32, frontZ, Math.min(w * 0.12, 0.04), 'hf');
  }

  // Subtle RoomLAB badge on bottom-right of the baffle.
  const badgeMat = new THREE.MeshStandardMaterial({
    color: 0x74d0ff, roughness: 0.3, metalness: 0.8, emissive: 0x103040, emissiveIntensity: 0.3,
  });
  const badge = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.1, h * 0.018, 0.002),
    badgeMat,
  );
  badge.position.set(w * 0.36, -h * 0.45, frontZ);
  group.add(badge);

  // Centre the group on origin.
  group.position.set(0, 0, 0);

  return group;
}

// Ceiling speaker: squat round cabinet, grille on top, driver cone
// visible through the grille. Upright orientation so the viewer sees
// the baffle face-on as the turntable spins.
function buildCeilingCabinet(group, def) {
  const dim = def.physical?.dimensions_m || { w: 0.2, h: 0.11, d: 0.2 };
  const dia = Math.max(dim.w ?? 0.2, dim.d ?? 0.2);
  const depth = dim.h ?? 0.11;
  const radius = dia / 2;
  const isSquare = def.physical?.shape === 'square';
  const isCoax = /coaxial|co-axial/i.test(def.model ?? '');
  const driverInches = def.physical?.driver_size_inches ?? 6;
  const driverR = Math.min(radius * 0.72, driverInches * 0.0127);   // rough real driver size

  // Cabinet body — cylinder (or square box for square-grille models).
  // Baffle side is +Y (the top of the cabinet in the preview), with
  // LARGER radius at that end; the back tapers down so the truncated-
  // cone shape reads clearly. Matches the ceiling cabinet placed in
  // the 3D viewport (which has baffle at +Z via its lookAt rotation).
  const rearR = radius * 0.72;
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xe9ebee, roughness: 0.72, metalness: 0.08,
  });
  const body = isSquare
    ? new THREE.Mesh(new THREE.BoxGeometry(dia, depth * 0.9, dia), bodyMat)
    : new THREE.Mesh(new THREE.CylinderGeometry(radius, rearR, depth * 0.9, 48), bodyMat);
  body.position.y = 0;
  group.add(body);

  // Top flange / bezel that sits below a real ceiling — thin disc on top.
  const bezelMat = new THREE.MeshStandardMaterial({
    color: 0xdadee2, roughness: 0.6, metalness: 0.25,
  });
  const bezel = isSquare
    ? new THREE.Mesh(new THREE.BoxGeometry(dia * 1.05, depth * 0.05, dia * 1.05), bezelMat)
    : new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.04, radius * 1.04, depth * 0.05, 48), bezelMat);
  bezel.position.y = depth * 0.45;
  group.add(bezel);

  // Grille — perforated disc. Faked with a slightly raised darker mesh
  // and a mild metallic shader; the whole thing sits on top of the body.
  const grilleY = depth * 0.48 + 0.002;
  const grilleMat = new THREE.MeshStandardMaterial({
    color: 0xd6dade, roughness: 0.45, metalness: 0.25,
  });
  const grille = isSquare
    ? new THREE.Mesh(new THREE.BoxGeometry(dia * 0.94, 0.003, dia * 0.94), grilleMat)
    : new THREE.Mesh(new THREE.CircleGeometry(radius * 0.92, 48), grilleMat);
  if (!isSquare) { grille.rotation.x = -Math.PI / 2; }
  grille.position.y = grilleY;
  group.add(grille);

  // Amperes brand badge on the grille — real logo PNG so the preview
  // matches what the 3D scene renders on the same cabinet.
  if (/amperes/i.test(def?.manufacturer || '') || /^amperes-/i.test(def?.id || '')) {
    const logoTex = getAmperesLogoTextureLocal();
    const logoW = radius * 0.50;
    const logoH = logoW * 0.75;          // amperes-logo.png ≈ 4:3
    const logo = new THREE.Mesh(
      new THREE.PlaneGeometry(logoW, logoH),
      new THREE.MeshBasicMaterial({ map: logoTex }),
    );
    logo.rotation.x = -Math.PI / 2;      // lie flat on the grille
    logo.position.set(0, grilleY + 0.001, -radius * 0.45);   // front area of the baffle disc
    group.add(logo);
  }

  // Driver cone — visible JUST under the grille so you can see the cone
  // behind the perforated metal. For coax there's a smaller tweeter in
  // the middle of the woofer.
  const coneDepth = depth * 0.25;
  const coneMat = new THREE.MeshStandardMaterial({
    color: 0x16191f, roughness: 0.65, metalness: 0.22,
  });
  const coneGeo = new THREE.ConeGeometry(driverR * 0.95, coneDepth, 48, 1, true);
  const cone = new THREE.Mesh(coneGeo, coneMat);
  cone.rotation.x = Math.PI;       // apex facing up → visible through grille
  cone.position.y = grilleY - coneDepth * 0.6;
  group.add(cone);
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(driverR * 0.24, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x2a2d34, roughness: 0.5, metalness: 0.3 }),
  );
  cap.position.y = grilleY - 0.003;
  group.add(cap);
  drivers.push({
    mesh: cone, cap, baseZ: cone.position.y, type: 'lf',
    pulseSpeed: 3.6, pulseAmp: 0.008, phase: 0,
    // Ceiling speakers pulse along Y not Z (driver points down/up in the
    // preview orientation). Override by setting a custom axis.
    axis: 'y',
  });

  if (isCoax) {
    // Small tweeter dome at the centre of the woofer.
    const tweeterMat = new THREE.MeshStandardMaterial({
      color: 0x22252a, roughness: 0.35, metalness: 0.55,
    });
    const tweeter = new THREE.Mesh(
      new THREE.SphereGeometry(driverR * 0.18, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      tweeterMat,
    );
    tweeter.position.y = grilleY - 0.001;
    group.add(tweeter);
    drivers.push({
      mesh: tweeter, baseZ: tweeter.position.y, type: 'hf',
      pulseSpeed: 13, pulseAmp: 0.002, phase: Math.PI / 3, axis: 'y',
    });
  }

  return group;
}

function addDriver(group, x, y, z, radius, type) {
  // Surround ring (outer black rubber surround).
  const surroundMat = new THREE.MeshStandardMaterial({
    color: 0x0e1014, roughness: 0.9, metalness: 0.1,
  });
  const surround = new THREE.Mesh(
    new THREE.RingGeometry(radius * 0.85, radius, 48),
    surroundMat,
  );
  surround.position.set(x, y, z);
  group.add(surround);

  // Cone — concave disc with subtle depth. We give it a cone geometry so the
  // visible pulse reads clearly when it moves in and out.
  const coneMat = new THREE.MeshStandardMaterial({
    color: type === 'hf' ? 0x22252a : 0x16191f,
    roughness: type === 'hf' ? 0.35 : 0.7,
    metalness: type === 'hf' ? 0.6 : 0.2,
  });
  const coneGeo = new THREE.ConeGeometry(radius * 0.9, radius * 0.55, 48, 1, true);
  const cone = new THREE.Mesh(coneGeo, coneMat);
  cone.position.set(x, y, z);
  cone.rotation.x = -Math.PI / 2;  // point +Z (outward)
  group.add(cone);

  // Dust cap at cone apex.
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.28, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x2a2d34, roughness: 0.5, metalness: 0.3 }),
  );
  cap.position.set(x, y, z + radius * 0.35);
  group.add(cap);

  drivers.push({
    mesh: cone,
    cap,
    surround,
    baseZ: z,
    type,
    pulseSpeed: type === 'hf' ? 12.5 : 3.4,
    pulseAmp:   type === 'hf' ? 0.0025 : 0.012,
    phase: Math.random() * Math.PI * 2,
  });
}

function addWaveguide(group, x, y, z, w, h) {
  // Rectangular HF waveguide with a central slot — typical line-array HF
  // output. Ribbon driver or compression driver behind it.
  const mat = new THREE.MeshStandardMaterial({
    color: 0x191d22, roughness: 0.3, metalness: 0.7,
  });
  const guide = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.02), mat);
  guide.position.set(x, y, z);
  group.add(guide);

  const slot = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.4, h * 0.85, 0.006),
    new THREE.MeshStandardMaterial({ color: 0x050608, roughness: 0.95, metalness: 0 }),
  );
  slot.position.set(x, y, z + 0.011);
  group.add(slot);

  drivers.push({
    mesh: guide,
    baseZ: z,
    type: 'hf',
    pulseSpeed: 15,
    pulseAmp: 0.0015,
    phase: 0,
  });
}

function fitCameraToModel(group, cam) {
  const box = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  const dist = maxDim * 2.6;
  const dir = new THREE.Vector3(0.7, 0.35, 1.0).normalize();
  cam.position.copy(dir.multiplyScalar(dist));
  cam.lookAt(0, 0, 0);
}

function animate() {
  if (!renderer || !scene || !camera) return;
  const t = performance.now() / 1000;

  // Camera orbit is now handled by OrbitControls (auto-rotate when idle,
  // user drag when active). Damping needs update() every frame.
  if (controls) controls.update();

  // Driver pulse — each driver oscillates along its local axis (default +Z
  // for vertical cabinets; +Y for ceiling speakers where the baffle faces
  // up). Speed + amplitude reflect the driver's bandwidth (HF small/fast,
  // LF big/slow).
  for (const drv of drivers) {
    const offset = Math.sin(t * drv.pulseSpeed + drv.phase) * drv.pulseAmp;
    const axis = drv.axis ?? 'z';
    drv.mesh.position[axis] = drv.baseZ + offset;
    if (drv.cap) {
      drv.cap.position[axis] = drv.baseZ + offset
        + (drv.mesh.geometry?.parameters?.radius ?? 0.05) * 0.35 * (axis === 'y' ? -1 : 1);
    }
  }

  renderer.render(scene, camera);
  animId = requestAnimationFrame(animate);
}
