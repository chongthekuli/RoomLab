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
import { createStudioRig, createStage, applyAutoFit, applyShadowFlags } from '../../shared/product-stage.js';

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let cabinetGroup = null;
let drivers = [];           // { mesh, cone, baseZ, type, pulseSpeed, pulseAmp }
let animId = null;
let lastDef = null;
let _amperesTextTex = null;

// Module-level cache for the small "amperes" wordmark texture. Mirrors
// the scene.js getAmperesTextTexture() — embossed-style brand plate
// rendered on a canvas so preview and 3D viewport share the same look.
function getAmperesTextTextureLocal() {
  if (_amperesTextTex) return _amperesTextTex;
  const W = 768, H = 192;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.font = 'bold 128px Arial, "Helvetica Neue", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = W / 2, cy = H / 2;
  ctx.fillStyle = 'rgba(60, 40, 0, 0.60)';
  ctx.fillText('amperes', cx + 3, cy + 3);
  ctx.fillStyle = 'rgba(255, 245, 200, 0.70)';
  ctx.fillText('amperes', cx - 2, cy - 2);
  ctx.fillStyle = '#D4AF37';
  ctx.fillText('amperes', cx, cy);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  _amperesTextTex = tex;
  return tex;
}

export function mountSpeaker3DPreview(canvas, def) {
  if (!canvas || !def) return;
  if (lastDef === def && renderer && renderer.domElement === canvas) return;
  disposePreview();

  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height, false);

  scene = new THREE.Scene();

  const aspect = width / height;
  camera = new THREE.PerspectiveCamera(35, aspect, 0.05, 20);
  camera.position.set(1.3, 0.45, 1.9);
  camera.lookAt(0, 0, 0);

  // Shared studio rig + walnut stage — same visual language as
  // SurfaceLAB so the Suite feels unified across labs.
  createStudioRig(renderer, scene);
  createStage(scene);

  cabinetGroup = buildCabinet(def);
  applyShadowFlags(cabinetGroup);
  scene.add(cabinetGroup);

  // Orbit controls — users can drag to rotate, right-drag to pan, scroll
  // to zoom. Auto-rotate keeps the cabinet turning when the mouse is
  // idle, and pauses when the user interacts. Damping gives a natural
  // inertial feel.
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.6;
  controls.enablePan = true;
  controls.panSpeed = 0.6;
  controls.zoomSpeed = 0.9;
  controls.maxPolarAngle = Math.PI * 0.55;

  // Auto-fit camera + controls target to the cabinet's actual bbox so
  // a 0.3 m bookshelf monitor and a 1.2 m tall line-array element both
  // fill the viewport consistently (Viktor spec §6).
  applyAutoFit(camera, controls, cabinetGroup);

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

  // Amperes commercial/installed categories — dedicated preview geometry so
  // a horn and a column read distinctly while the model orbits. The preview
  // orientation is independent of the in-scene aim (the model just spins);
  // we favour "baffle / mouth faces +Z (camera-ish)", same as the generic
  // vertical 2-way below and buildCeilingCabinet. Mirrors the scene.js
  // category builders (buildHornEnclosure etc.).
  const mount = def.mount_type;
  if (mount === 'surface-mount')   return buildSurfaceMountCabinet(group, def);
  if (mount === 'full-range')      return buildFullRangeCabinet(group, def);
  if (mount === 'column')          return buildColumnCabinet(group, def);
  if (mount === 'horn')            return buildHornCabinet(group, def);
  if (mount === 'sound-projector') return buildSoundProjectorCabinet(group, def);
  if (mount === 'garden')          return buildGardenBollardCabinet(group, def);
  if (mount === 'pendant')         return buildPendantCabinet(group, def);

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

  // Amperes "amperes" wordmark — embossed-style canvas text tag on
  // the grille. Same textured plane logic as in scene.js so preview
  // and 3D viewport match.
  if (/amperes/i.test(def?.manufacturer || '') || /^amperes-/i.test(def?.id || '')) {
    const textTex = getAmperesTextTextureLocal();
    const textW = radius * 0.56;
    const textH = textW * 0.25;          // canvas 768 × 192 ≈ 4:1
    const badge = new THREE.Mesh(
      new THREE.PlaneGeometry(textW, textH),
      new THREE.MeshBasicMaterial({ map: textTex, transparent: true }),
    );
    badge.rotation.x = -Math.PI / 2;     // lie flat on the grille
    badge.position.set(0, grilleY + 0.001, -radius * 0.55);
    group.add(badge);
  }

  // Driver — a flat disc just under the grille (static, flush). Sits
  // slightly below the grille plane so it reads as the cone seen through
  // the perforated metal. No protruding cone/cap, no animation.
  const coneMat = new THREE.MeshStandardMaterial({
    color: 0x16191f, roughness: 0.65, metalness: 0.22, side: THREE.DoubleSide,
  });
  const cone = new THREE.Mesh(new THREE.CircleGeometry(driverR * 0.92, 48), coneMat);
  cone.rotation.x = -Math.PI / 2;  // lie flat, face up through the grille
  cone.position.y = grilleY - 0.004;
  group.add(cone);

  if (isCoax) {
    // Small tweeter disc at the centre of the woofer (static, flush).
    const tweeterMat = new THREE.MeshStandardMaterial({
      color: 0x22252a, roughness: 0.35, metalness: 0.55, side: THREE.DoubleSide,
    });
    const tweeter = new THREE.Mesh(new THREE.CircleGeometry(driverR * 0.2, 32), tweeterMat);
    tweeter.rotation.x = -Math.PI / 2;
    tweeter.position.y = grilleY - 0.002;
    group.add(tweeter);
  }

  return group;
}

// ---------------------------------------------------------------------------
// Amperes commercial / installed-sound preview builders.
//
// The preview model orbits, so orientation is chosen purely for legibility:
// the firing face (baffle / horn mouth / tube end) points +Z (toward the
// camera's start pose) for the directional types; bollard stands along +Y;
// pendant hangs with its cable at +Y. These mirror the scene.js category
// builders but use the preview's existing addDriver()/badge helpers so the
// drivers visibly pulse. Dispose-safe: only standard meshes are added, and
// drivers[] is cleared in disposePreview().
// ---------------------------------------------------------------------------

// Finish lookup — maps a JSON `physical.finish` token to a body material
// spec. Mirrors scene.js _finishMaterial so preview + 3D viewport match.
// Amperes commercial gear is mostly white / aluminium / grey; only a few
// are black. The preview never places speakers "outside" (that's a scene
// concept), but the helper keeps the `outside` red-tint override for
// signature parity with scene.js. Finish only colours the BODY; the
// grille keeps its own dark tint.
const _FINISH_SPECS = {
  'white':     { color: 0xeef0f2, roughness: 0.72, metalness: 0.05 },
  'off-white': { color: 0xe9ebee, roughness: 0.72, metalness: 0.08 },
  'aluminium': { color: 0xc2c6cc, roughness: 0.35, metalness: 0.85 },
  'grey':      { color: 0x9a9ea5, roughness: 0.6,  metalness: 0.25 },
  'black':     { color: 0x1c1f24, roughness: 0.6,  metalness: 0.3  },
  'green':     { color: 0x2f4a38, roughness: 0.7,  metalness: 0.1  },
};
function _finishMaterial(finish, outside) {
  if (outside) {
    return new THREE.MeshStandardMaterial({ color: 0x6a1a0c, roughness: 0.72, metalness: 0.3 });
  }
  const spec = _FINISH_SPECS[finish] || _FINISH_SPECS['white'];
  return new THREE.MeshStandardMaterial({ ...spec });
}
// Read the finish token off a speaker def (defaults to white when absent).
const _defFinish = (def) => def?.physical?.finish || 'white';

const PREVIEW_BODY = (finish, outside = false) => _finishMaterial(finish, outside);
const PREVIEW_METAL = () => new THREE.MeshStandardMaterial({ color: 0x8a8e98, roughness: 0.3, metalness: 0.85 });
const PREVIEW_GRILLE = () => new THREE.MeshStandardMaterial({ color: 0x2a2f37, roughness: 0.85, metalness: 0.12, side: THREE.DoubleSide });

// Box-type FULL-FACE grille — mirrors scene.js _spkBoxGrilleMat. The
// catalogue BS506/508/410 read as a WHITE speaker with a fine mesh grille,
// no black driver cone. Derive a LIGHT mesh colour from the finish, nudged a
// shade darker for a fabric look, low metalness. The preview has no
// speaker-group tint, so no blend term here. Used by surface-mount (box),
// full-range and column ONLY; horn/projector/garden/pendant keep PREVIEW_GRILLE.
function _previewBoxGrilleMat(finish) {
  const base = new THREE.Color((_FINISH_SPECS[finish] || _FINISH_SPECS['white']).color);
  base.multiplyScalar(0.86);
  return new THREE.MeshStandardMaterial({ color: base, roughness: 0.92, metalness: 0.06, side: THREE.DoubleSide });
}

// Faint recessed driver hint placed BEHIND a full-face grille (mirrors
// scene.js _addRecessedDriverHint). Dim ring + dark disc set back from the
// grille plane so the driver is a subtle shadow through the mesh, never a
// glossy disc proud of the baffle. Static — registers nothing for animation.
function addRecessedDriverHint(group, x, y, r, grilleZ) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(r * 0.86, r, 32),
    new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.95, metalness: 0.05, side: THREE.DoubleSide }),
  );
  ring.position.set(x, y, grilleZ - 0.006);
  group.add(ring);
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(r * 0.86, 32),
    new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.9, metalness: 0.08 }),
  );
  disc.position.set(x, y, grilleZ - 0.008);
  group.add(disc);
}

// Small "amperes" wordmark plane facing +Z at (x,y,z). `cabW` is the cabinet
// width; the badge is ~0.28× of it (height 0.25× the badge width for the 4:1
// canvas) so it reads small and subtle — matching the ceiling-speaker badge,
// NOT the old plateW*0.7 which dominated the baffle. Flat plane only; curved
// bodies use addAmperesBadgeCurvedLocalY.
//
// Mirror note: the WORKBENCH preview has NO scene.scale.x = -1 (that mirror
// lives only in scene.js), so this local texture is NOT x-flipped and reads
// correctly as-is.
function addAmperesBadgeLocal(group, def, x, y, z, cabW) {
  if (!(/amperes/i.test(def?.manufacturer || '') || /^amperes-/i.test(def?.id || ''))) return;
  const textTex = getAmperesTextTextureLocal();
  const textW = cabW * 0.28;
  const textH = textW * 0.25;
  const badge = new THREE.Mesh(
    new THREE.PlaneGeometry(textW, textH),
    new THREE.MeshBasicMaterial({ map: textTex, transparent: true }),
  );
  badge.position.set(x, y, z);
  group.add(badge);
}

// Wraps the "amperes" wordmark onto a CURVED, +Y-axis body (bollard base,
// horn throat, pendant sphere) so the sticker follows the surface. Thin
// open-ended CylinderGeometry arc, radius `r`, centred at vertical `cy`,
// swept symmetrically about the +Z meridian so it faces the camera-ish aim.
// `arcFrac` = badge width as a fraction of circumference; height keeps 4:1.
function addAmperesBadgeCurvedLocalY(group, def, r, cy, arcFrac) {
  if (!(/amperes/i.test(def?.manufacturer || '') || /^amperes-/i.test(def?.id || ''))) return;
  const textTex = getAmperesTextTextureLocal();
  const arcLen = 2 * Math.PI * r * arcFrac;
  const thetaLength = 2 * Math.PI * arcFrac;
  const badgeH = arcLen * 0.25;
  // +Z FRONT is at θ=0 (x=r·sinθ, z=r·cosθ); θ=π/2 is the +X SIDE. Centre on
  // θ=0 so the badge sits on the front of the bulge.
  const thetaStart = -thetaLength / 2;
  const geo = new THREE.CylinderGeometry(
    r * 1.006, r * 1.006, badgeH, 20, 1, true, thetaStart, thetaLength,
  );
  const badge = new THREE.Mesh(
    geo, new THREE.MeshBasicMaterial({ map: textTex, transparent: true, side: THREE.DoubleSide }),
  );
  badge.position.y = cy;
  group.add(badge);
}

// Closed, correctly-wound tapered box (back face scaled by backFrac) built
// off BoxGeometry so winding/normals are solid — the hand-rolled trapezoid
// had an inverted front face that rendered see-through.
function taperedBoxGeo(w, h, d, backFrac) {
  const g = new THREE.BoxGeometry(w, h, d);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getZ(i) < 0) { p.setX(i, p.getX(i) * backFrac); p.setY(i, p.getY(i) * backFrac); }
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// Framed inset grille for box-type cabinets — darker recess frame + lighter
// mesh panel proud of it, so the white body shows a border and the grille
// reads as a real framed mesh insert (not a blank same-colour face).
function addBoxGrille(group, w, h, baffleZ, finish) {
  const frame = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 0.92, h * 0.92),
    new THREE.MeshStandardMaterial({ color: 0x6f747b, roughness: 0.85, metalness: 0.15 }),
  );
  frame.position.z = baffleZ;
  group.add(frame);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.84, h * 0.84), _previewBoxGrilleMat(finish));
  mesh.position.z = baffleZ + 0.004;
  group.add(mesh);
}

function buildSurfaceMountCabinet(group, def) {
  const dim = def.physical?.dimensions_m || { w: 0.17, h: 0.17, d: 0.09 };
  const w = dim.w ?? 0.17, h = dim.h ?? 0.17, d = dim.d ?? 0.09;
  const isHalfMoon = def.physical?.shape === 'box-halfmoon';
  const finish = _defFinish(def);

  if (isHalfMoon) {
    // BS410 D-PROFILE wall speaker. Per the product owner: CURVED face is the
    // FRONT/firing direction (+Z) with the grille on it; FLAT face mounts to
    // the wall. CylinderGeometry thetaStart=-90°, len=180° → bulge points +Z.
    const radius = d;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, h, 32, 1, false, -Math.PI / 2, Math.PI),
      PREVIEW_BODY(finish),
    );
    group.add(body);
    // Flat BACK plate closing the cut, flush to the wall at z≈0.
    const back = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.012), PREVIEW_BODY(finish));
    back.position.z = -0.005;
    group.add(back);
    // Curved mesh grille on the front bulge (+Z); badge wrapped on the curve.
    const grille = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 1.012, radius * 1.012, h * 0.94, 32, 1, true, -Math.PI / 2, Math.PI),
      _previewBoxGrilleMat(finish),
    );
    group.add(grille);
    // Badge wrapped on the curved front, CENTRED on the +Z apex (cy = 0).
    addAmperesBadgeCurvedLocalY(group, def, radius * 1.016, -h * 0.15, (0.34 * w) / (2 * Math.PI * radius));
  } else {
    // BS506/508 surface-mount box — front baffle larger than back, sides taper
    // to the wall. Framed mesh grille; gold badge centred. No rear black box.
    const body = new THREE.Mesh(taperedBoxGeo(w, h, d, 0.78), PREVIEW_BODY(finish));
    group.add(body);
    const baffleZ = d / 2 + 0.004;
    addBoxGrille(group, w, h, baffleZ, finish);
    addAmperesBadgeLocal(group, def, 0, 0, baffleZ + 0.008, w);
  }
  return group;
}

function buildFullRangeCabinet(group, def) {
  const dim = def.physical?.dimensions_m || { w: 0.16, h: 0.26, d: 0.16 };
  const w = dim.w ?? 0.16, h = dim.h ?? 0.26, d = dim.d ?? 0.16;
  const finish = _defFinish(def);
  // FS650 full-range — same family as the BS508 box: front baffle larger than
  // the back, sides taper to the wall, portrait. Framed mesh grille; gold badge
  // low-centre. Black finish. No rear black box.
  const body = new THREE.Mesh(taperedBoxGeo(w, h, d, 0.78), PREVIEW_BODY(finish));
  group.add(body);
  const baffleZ = d / 2 + 0.004;
  addBoxGrille(group, w, h, baffleZ, finish);
  addAmperesBadgeLocal(group, def, 0, -h * 0.36, baffleZ + 0.008, w);
  return group;
}

function buildColumnCabinet(group, def) {
  const dim = def.physical?.dimensions_m || { w: 0.09, h: 0.66, d: 0.09 };
  const w = dim.w ?? 0.09, h = dim.h ?? 0.66, d = dim.d ?? 0.09;
  const n = Math.max(2, Math.min(16, (def.physical?.driver_count ?? 4) | 0));
  const finish = _defFinish(def);
  // CL740/780/900 column. CATALOGUE PHOTO: tall slim cabinet, slim FRAME
  // border around a full vertical mesh grille, four corner SCREWS, grey rear
  // mounting bracket, tiny badge at the very BOTTOM.
  const bodyMat = PREVIEW_BODY(finish);
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bodyMat);
  group.add(body);
  const baffleZ = d / 2 + 0.004;
  // Slim frame border framing the recessed mesh grille.
  const frame = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.98, h * 0.99), bodyMat);
  frame.position.z = baffleZ - 0.001;
  group.add(frame);
  const grille = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.82, h * 0.93), _previewBoxGrilleMat(finish));
  grille.position.z = baffleZ;
  group.add(grille);
  const usable = h * 0.88;
  const pitch = usable / n;
  const r = Math.min(w * 0.30, pitch * 0.42);
  for (let i = 0; i < n; i++) {
    const y = -usable / 2 + pitch * (i + 0.5);
    addRecessedDriverHint(group, 0, y, r, baffleZ);
  }
  // Four corner screws.
  const screwMat = new THREE.MeshStandardMaterial({ color: 0x3a3e44, roughness: 0.5, metalness: 0.7 });
  const screwR = Math.min(w * 0.08, 0.006);
  const sx = w * 0.42, sy = h * 0.47;
  for (const [px, py] of [[-sx, sy], [sx, sy], [-sx, -sy], [sx, -sy]]) {
    const screw = new THREE.Mesh(new THREE.CircleGeometry(screwR, 12), screwMat);
    screw.position.set(px, py, baffleZ + 0.001);
    group.add(screw);
  }
  // Grey rear mounting bracket.
  const bracket = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, h * 0.5, 0.025), PREVIEW_METAL());
  bracket.position.set(0, 0, -d / 2 - 0.014);
  group.add(bracket);
  // Tiny badge at the very bottom (sized off h since the column is narrow).
  addAmperesBadgeLocal(group, def, 0, -h * 0.47, baffleZ + 0.004, h * 0.22);
  return group;
}

// Exponential horn-bell profile (trumpet flare) — see scene.js _hornBellGeo.
function previewHornBellGeo(throatR, mouthR, bellLen) {
  const pts = [];
  const N = 18;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const r = throatR * Math.pow(mouthR / throatR, Math.pow(t, 1.7));
    pts.push(new THREE.Vector2(Math.max(r, 0.003), t * bellLen));
  }
  const g = new THREE.LatheGeometry(pts, 40);
  g.rotateX(Math.PI / 2);
  return g;
}

function buildHornCabinet(group, def) {
  const dim = def.physical?.dimensions_m || { w: 0.21, h: 0.21, d: 0.2 };
  const w = dim.w ?? 0.21, h = dim.h ?? 0.21, d = dim.d ?? 0.2;
  const isRect = def.physical?.shape === 'horn-rect';
  const mouthR = Math.max(w, h) / 2;
  const throatR = Math.max(0.02, mouthR * 0.26);
  const bellLen = Math.min(d, mouthR * 1.4);
  const tubeLen = Math.max(mouthR * 0.35, d - bellLen);
  const mouthZ = d / 2;
  const throatZ = mouthZ - bellLen;
  const bodyMat = PREVIEW_BODY(_defFinish(def));
  bodyMat.side = THREE.DoubleSide;             // see inside the bell

  if (isRect) {
    // Rounded-rect flare, no fins.
    const mw = w / 2, mh = h / 2, tw = mw * 0.26, th = mh * 0.26;
    const verts = new Float32Array([
      -mw, -mh, mouthZ,  mw, -mh, mouthZ,  mw, mh, mouthZ,  -mw, mh, mouthZ,
      -tw, -th, throatZ, tw, -th, throatZ, tw, th, throatZ, -tw, th, throatZ,
    ]);
    const idx = [0, 1, 5, 0, 5, 4,  1, 2, 6, 1, 6, 5,  2, 3, 7, 2, 7, 6,  3, 0, 4, 3, 4, 7];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    group.add(new THREE.Mesh(geo, bodyMat));
  } else {
    // Round exponential bell (trumpet flare).
    const bell = new THREE.Mesh(previewHornBellGeo(throatR, mouthR, bellLen), bodyMat);
    bell.position.z = throatZ;
    group.add(bell);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(mouthR * 0.99, mouthR * 0.04, 10, 32), PREVIEW_METAL());
    rim.position.z = mouthZ;
    group.add(rim);
  }

  // Driver tube + motor pod running back from the throat (no pulse — static).
  const tube = new THREE.Mesh(
    new THREE.CylinderGeometry(throatR * 1.15, throatR * 1.05, tubeLen, 20, 1, false),
    PREVIEW_BODY(_defFinish(def)),
  );
  tube.rotation.x = Math.PI / 2;
  tube.position.z = throatZ - tubeLen / 2;
  group.add(tube);
  const motor = new THREE.Mesh(
    new THREE.CylinderGeometry(throatR * 1.35, throatR * 1.2, mouthR * 0.35, 18), PREVIEW_METAL(),
  );
  motor.rotation.x = Math.PI / 2;
  motor.position.z = throatZ - tubeLen - mouthR * 0.12;
  group.add(motor);
  // Throat cap (so the bell isn't see-through) + small badge on it.
  const cap = new THREE.Mesh(new THREE.CircleGeometry(throatR * 1.05, 20), PREVIEW_GRILLE());
  cap.position.z = throatZ + 0.003;
  group.add(cap);
  addAmperesBadgeLocal(group, def, 0, 0, throatZ + 0.005, throatR * 3.4);

  // U-yoke bracket, hinged at the tube, dropping below.
  const yokeMat = PREVIEW_METAL();
  const armThick = Math.max(0.006, mouthR * 0.05);
  const dropY = mouthR * 0.9;
  const yokeZ = throatZ - tubeLen * 0.35;
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(armThick, dropY, armThick), yokeMat);
    arm.position.set(sx * (throatR * 1.5 + armThick), -dropY * 0.5, yokeZ);
    group.add(arm);
  }
  const cross = new THREE.Mesh(new THREE.BoxGeometry(throatR * 3 + armThick * 2, armThick, armThick), yokeMat);
  cross.position.set(0, -dropY, yokeZ);
  group.add(cross);
  return group;
}

function buildSoundProjectorCabinet(group, def) {
  const dim = def.physical?.dimensions_m || { w: 0.13, h: 0.28, d: 0.13 };
  const w = dim.w ?? 0.13, h = dim.h ?? 0.28, d = dim.d ?? 0.13;
  const bi = def.physical?.shape === 'cylinder-bi';
  const radius = Math.max(w, d) / 2;
  const len = h;
  // SP220 sound projector. CATALOGUE PHOTO: horizontal RIBBED tube, mesh
  // grille recessed in the circular FIRING END (+Z), rounded U-yoke under.
  const bodyMat = PREVIEW_BODY(_defFinish(def));
  const geo = new THREE.CylinderGeometry(radius, radius, len, 32);
  geo.rotateX(Math.PI / 2);                     // axis → +Z
  const body = new THREE.Mesh(geo, bodyMat);
  group.add(body);

  // Longitudinal RIBS around the tube.
  const ribCount = 16;
  for (let i = 0; i < ribCount; i++) {
    const ang = (i / ribCount) * Math.PI * 2;
    const rib = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.04, radius * 0.06, len * 0.9), bodyMat);
    rib.position.set(Math.cos(ang) * radius, Math.sin(ang) * radius, 0);
    rib.rotation.z = ang;
    group.add(rib);
  }

  const grilleMat = PREVIEW_GRILLE();
  const coneMat = new THREE.MeshStandardMaterial({ color: 0x16191f, roughness: 0.65, metalness: 0.22, side: THREE.DoubleSide });
  const addEndCap = (zSign) => {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.94, radius * 0.06, 8, 24), bodyMat);
    rim.position.z = zSign * (len / 2 + 0.004);
    group.add(rim);
    const grille = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.9, 24), grilleMat);
    grille.position.z = zSign * (len / 2 + 0.002);
    grille.rotation.y = zSign > 0 ? 0 : Math.PI;
    group.add(grille);
    const cone = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.62, 20), coneMat);
    cone.position.z = zSign * (len / 2 - 0.012);
    cone.rotation.y = zSign > 0 ? 0 : Math.PI;
    group.add(cone);
  };
  addEndCap(+1);
  if (bi) addEndCap(-1);

  // U-YOKE bracket underneath.
  const yokeMat = PREVIEW_METAL();
  const yokeR = radius * 1.5;
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.1, yokeR, radius * 0.1), yokeMat);
    arm.position.set(sx * radius * 1.05, -yokeR * 0.4, 0);
    group.add(arm);
    const stud = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.12, radius * 0.12, radius * 0.16, 12), yokeMat);
    stud.rotation.z = Math.PI / 2;
    stud.position.set(sx * radius * 1.02, 0, 0);
    group.add(stud);
  }
  const bottom = new THREE.Mesh(new THREE.BoxGeometry(radius * 2.2, radius * 0.1, radius * 0.1), yokeMat);
  bottom.position.set(0, -yokeR * 0.85, 0);
  group.add(bottom);

  // Wordmark wraps the TOP of the tube (axis +Z) following the curve.
  if (/amperes/i.test(def?.manufacturer || '') || /^amperes-/i.test(def?.id || '')) {
    const textTex = getAmperesTextTextureLocal();
    const arcFrac = 0.34;
    const arcLen = 2 * Math.PI * radius * arcFrac;
    const thetaLength = 2 * Math.PI * arcFrac;
    const badgeLen = arcLen * 0.25;
    const thetaStart = Math.PI / 2 - thetaLength / 2;   // +Y top is at θ=π/2
    const bgeo = new THREE.CylinderGeometry(radius * 1.05, radius * 1.05, badgeLen, 20, 1, true, thetaStart, thetaLength);
    bgeo.rotateX(Math.PI / 2);                   // axis +Y → +Z (tube axis)
    const badge = new THREE.Mesh(bgeo, new THREE.MeshBasicMaterial({ map: textTex, transparent: true, side: THREE.DoubleSide }));
    group.add(badge);
  }
  return group;
}

function buildGardenBollardCabinet(group, def) {
  const dim = def.physical?.dimensions_m || { w: 0.18, h: 0.32, d: 0.18 };
  const w = dim.w ?? 0.18, h = dim.h ?? 0.32;
  const radius = w / 2;
  const finish = _defFinish(def);
  const bodyMat = PREVIEW_BODY(finish);
  // SG320 MUSHROOM bollard. CATALOGUE PHOTO: truncated-cone base (wider at
  // bottom), domed CAP floating above on short posts, driver fires UP through
  // the GAP, foot tabs at the bottom. Recentre by yOff so it sits on origin.
  const yOff = -h * 0.4;
  const baseH = h * 0.55, baseBotR = radius, baseTopR = radius * 0.72;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(baseTopR, baseBotR, baseH, 28), bodyMat);
  base.position.y = baseH / 2 + yOff;
  group.add(base);
  const baseTop = new THREE.Mesh(
    new THREE.CircleGeometry(baseTopR, 28),
    new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 0.9, metalness: 0.1, side: THREE.DoubleSide }),
  );
  baseTop.rotation.x = -Math.PI / 2;
  baseTop.position.y = baseH + yOff;
  group.add(baseTop);
  // Upward-firing driver in the gap + centre post.
  const driver = new THREE.Mesh(
    new THREE.ConeGeometry(baseTopR * 0.6, h * 0.16, 24, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x16191f, roughness: 0.65, metalness: 0.22, side: THREE.DoubleSide }),
  );
  driver.position.y = baseH + h * 0.08 + yOff;
  group.add(driver);
  const centrePost = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.12, radius * 0.12, h * 0.26, 12), bodyMat);
  centrePost.position.y = baseH + h * 0.13 + yOff;
  group.add(centrePost);
  // Outer posts holding the cap.
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const post = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.1, h * 0.26, radius * 0.1), bodyMat);
    post.position.set(Math.cos(ang) * baseTopR * 0.9, baseH + h * 0.13 + yOff, Math.sin(ang) * baseTopR * 0.9);
    group.add(post);
  }
  // Floating cap.
  const capR = radius * 1.05, capY = baseH + h * 0.26 + yOff;
  const cap = new THREE.Mesh(new THREE.SphereGeometry(capR, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.5), bodyMat);
  cap.position.y = capY;
  group.add(cap);
  const capUnder = new THREE.Mesh(
    new THREE.CircleGeometry(capR, 28),
    new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 0.9, metalness: 0.1, side: THREE.DoubleSide }),
  );
  capUnder.rotation.x = Math.PI / 2;
  capUnder.position.y = capY;
  group.add(capUnder);
  // Foot tabs.
  for (let i = 0; i < 3; i++) {
    const ang = (i / 3) * Math.PI * 2;
    const tab = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.18, h * 0.04, radius * 0.1), bodyMat);
    tab.position.set(Math.cos(ang) * radius * 1.02, h * 0.02 + yOff, Math.sin(ang) * radius * 1.02);
    tab.rotation.y = -ang;
    group.add(tab);
  }
  // Badge wraps the curved base just below the gap.
  addAmperesBadgeCurvedLocalY(group, def, baseTopR * 1.02, baseH * 0.62 + yOff, 0.30);
  return group;
}

function buildPendantCabinet(group, def) {
  const dim = def.physical?.dimensions_m || { w: 0.25, h: 0.25, d: 0.25 };
  const w = dim.w ?? 0.25;
  const radius = w / 2;
  const finish = _defFinish(def);
  const bodyMat = PREVIEW_BODY(finish);
  // PS820 hanging SPHERE. CATALOGUE PHOTO: white sphere from a ceiling cup on
  // a thin cable, cable-clamp collar at the sphere top, recessed FINNED down-
  // firing opening at the bottom. Upper hemisphere smooth.
  const upper = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.62), bodyMat,
  );
  group.add(upper);
  const lower = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.002, 28, 18, 0, Math.PI * 2, Math.PI * 0.62, Math.PI * 0.20), bodyMat,
  );
  group.add(lower);
  // Recessed down-firing opening with radial fin vanes.
  const openR = radius * 0.62;
  const recess = new THREE.Mesh(
    new THREE.CylinderGeometry(openR, openR * 0.86, radius * 0.5, 24, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 0.9, metalness: 0.1, side: THREE.DoubleSide }),
  );
  recess.position.y = -radius * 0.62;
  group.add(recess);
  const cone = new THREE.Mesh(
    new THREE.CircleGeometry(openR * 0.86, 24),
    new THREE.MeshStandardMaterial({ color: 0x16191f, roughness: 0.65, metalness: 0.22, side: THREE.DoubleSide }),
  );
  cone.rotation.x = -Math.PI / 2;               // face down (-Y)
  cone.position.y = -radius * 0.4;
  group.add(cone);
  for (let i = 0; i < 6; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(openR * 1.7, radius * 0.46, radius * 0.03), bodyMat);
    fin.rotation.y = (i / 6) * Math.PI;
    fin.position.y = -radius * 0.62;
    group.add(fin);
  }
  // Ceiling cup + cable + clamp collar.
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.34, radius * 0.22, radius * 0.34, 18), bodyMat);
  cup.position.y = radius * 2.1;
  group.add(cup);
  const cable = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.035, radius * 0.035, radius * 1.6, 8),
    new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.5, metalness: 0.3 }),
  );
  cable.position.y = radius * 1.25;
  group.add(cable);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.12, radius * 0.14, radius * 0.12, 14), bodyMat);
  collar.position.y = radius * 0.96;
  group.add(collar);
  // Badge wraps the curved sphere just below the equator.
  addAmperesBadgeCurvedLocalY(group, def, radius * 0.95, -radius * 0.3, 0.26);
  return group;
}

// STATIC, FLUSH driver disc. The driver no longer pulses (the old
// ConeGeometry + dust-cap pulse made the cone + cap visibly detach and
// float away from the baffle — worst on the column with many drivers).
// We now render a flat disc flush against the baffle, matching the
// scene.js `_addBaffleDrivers` look, and register NOTHING for animation.
// The dust cap is dropped: a sphere-on-a-flat-disc can't sit flush
// statically without protruding, so per spec we remove it rather than
// leave a floating dome.
function addDriver(group, x, y, z, radius, type) {
  // Surround ring (outer black rubber surround).
  const surroundMat = new THREE.MeshStandardMaterial({
    color: 0x0e1014, roughness: 0.9, metalness: 0.1, side: THREE.DoubleSide,
  });
  const surround = new THREE.Mesh(
    new THREE.RingGeometry(radius * 0.82, radius, 48),
    surroundMat,
  );
  surround.position.set(x, y, z + 0.001);
  group.add(surround);

  // Cone — a flat circular membrane flush on the baffle (no protruding
  // geometry, no animation). HF discs read a touch brighter/metallic.
  const coneMat = new THREE.MeshStandardMaterial({
    color: type === 'hf' ? 0x22252a : 0x16191f,
    roughness: type === 'hf' ? 0.35 : 0.7,
    metalness: type === 'hf' ? 0.6 : 0.2,
  });
  const cone = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.82, 48), coneMat);
  cone.position.set(x, y, z);   // faces +Z by default — flush on baffle
  group.add(cone);
  // No drivers.push() — drivers are static now; nothing animates.
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
  // Static waveguide — no pulse registration.
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

  // Resize sync — when the canvas's CSS size changes (viewport resize,
  // panel open/close, route switch), update the renderer's pixel
  // buffer + camera aspect so the 3D image fills the new bounds
  // without stretching. Cheap: a few comparisons per frame.
  const canvasEl = renderer.domElement;
  const cssW = canvasEl.clientWidth;
  const cssH = canvasEl.clientHeight;
  if (cssW > 0 && cssH > 0) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);
    if (canvasEl.width !== targetW || canvasEl.height !== targetH) {
      renderer.setSize(cssW, cssH, false);
      camera.aspect = cssW / cssH;
      camera.updateProjectionMatrix();
    }
  }

  // Camera orbit is now handled by OrbitControls (auto-rotate when idle,
  // user drag when active). Damping needs update() every frame.
  if (controls) controls.update();

  // Driver pulse REMOVED — drivers are now static. The old oscillation
  // moved cones (and a buggy cap-offset that used ConeGeometry's missing
  // `.radius` param) so the cone + dust cap visibly detached and floated
  // off the baffle, worst on the column. Nothing moves now; `drivers[]`
  // is intentionally left empty by the builders. `t` retained for any
  // future material breathing but currently unused.
  void t;

  renderer.render(scene, camera);
  animId = requestAnimationFrame(animate);
}
