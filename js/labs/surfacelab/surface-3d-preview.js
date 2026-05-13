// SurfaceLAB 3D preview. Two visual idioms picked at runtime by entry
// kind:
//
//   1. PLAIN FINISHES (sample_panel) — a 1m square sample of the
//      surface as it would appear applied to a wall, with a texture
//      pattern mapped to the visual descriptor (concrete, brick, wood,
//      carpet, fabric, etc.). Lit + slowly auto-rotating turntable so
//      you can read both the face and the depth.
//
//   2. ENGINEERED PRODUCTS — procedural Three.js geometry generated
//      from the entry's `geometry` block. QRDs build a vertical/
//      horizontal well array from the prime-root sequence. Skylines
//      build a 2D depth grid. Polycyls build a curved surface. Panels
//      build flat fabric-wrapped boxes. Bass traps build wedge or
//      membrane geometry.
//
// All rendered with the same camera + lighting rig + OrbitControls
// (auto-rotate when idle) for visual consistency with SpeakerLAB.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createStudioRig, createStage, applyAutoFit, applyShadowFlags } from '../../shared/product-stage.js';

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let animId = null;
let group = null;
let lastEntryId = null;

// ---------------------------------------------------------------------
// Mount / dispose
//
// First call sets up renderer + scene + studio rig + walnut stage
// (one-time init; persists across product switches). Subsequent calls
// remove the previous product group and add a new one — stage and
// rig stay alive so the env-map / shadow-map allocations aren't
// rebuilt on every selection (Viktor's perf budget).
// ---------------------------------------------------------------------

export function mountSurfacePreview(canvas, entry) {
  if (!entry) return;
  if (lastEntryId === entry.id && renderer) return;

  if (!renderer) {
    initStage(canvas);
  }
  swapProduct(entry);
  lastEntryId = entry.id;
}

function initStage(canvas) {
  const w = canvas.clientWidth || canvas.width || 800;
  const h = canvas.clientHeight || canvas.height || 600;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(35, w / h, 0.05, 20);
  camera.position.set(0.9, 0.55, 1.4);
  camera.lookAt(0, 0, 0);

  // Shared studio rig: 3-light + RoomEnvironment PMREM + AgX tone map.
  createStudioRig(renderer, scene);
  // Walnut disc + contact shadow + gradient cyc background.
  createStage(scene);

  // OrbitControls — drag to rotate, scroll to zoom, auto-rotate idle.
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.4;
  controls.maxDistance = 4.0;
  controls.maxPolarAngle = Math.PI * 0.55;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.8;

  // Pause auto-rotate while the user is interacting; resume after a
  // short idle window so the model keeps moving when they walk away.
  let idleTimer = null;
  const pause = () => { controls.autoRotate = false; clearTimeout(idleTimer); };
  const resume = () => { idleTimer = setTimeout(() => { controls.autoRotate = true; }, 1500); };
  canvas.addEventListener('pointerdown', pause);
  canvas.addEventListener('pointerup', resume);
  canvas.addEventListener('wheel', () => { pause(); resume(); }, { passive: true });

  animate();
}

function swapProduct(entry) {
  // Remove previous product group (keep stage + lights + env map).
  if (group) {
    scene.remove(group);
    disposeGroup(group);
    group = null;
  }
  // Build new product group. Builders return native-dimensions geometry;
  // applyAutoFit handles per-product centring + camera framing so
  // every product fills the viewport consistently.
  group = buildSampleGroup(entry);
  applyShadowFlags(group);
  scene.add(group);
  applyAutoFit(camera, controls, group);
}

function disposeGroup(g) {
  g.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
}

export function disposePreview() {
  if (animId != null) {
    cancelAnimationFrame(animId);
    animId = null;
  }
  if (controls) { controls.dispose(); controls = null; }
  if (renderer) { renderer.dispose(); renderer = null; }
  scene = null;
  camera = null;
  group = null;
  lastEntryId = null;
}

function animate() {
  if (!renderer || !scene || !camera) return;

  // Resize sync — SpeakerLAB pattern. Cheap; runs every frame.
  const canvas = renderer.domElement;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW > 0 && cssH > 0) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      renderer.setSize(cssW, cssH, false);
      camera.aspect = cssW / cssH;
      camera.updateProjectionMatrix();
    }
  }

  if (controls) controls.update();
  renderer.render(scene, camera);
  animId = requestAnimationFrame(animate);
}

// ---------------------------------------------------------------------
// Sample builder — picks the right geometry family per entry category.
//
// Schema v2 (Oct 2026) uses dotted-path categories like
// "absorber.porous.foam" / "diffuser.qrd_1d". Some categories collapse
// physically-distinct shapes (wedge vs pyramid foam; cylinder vs
// triangle corner trap; polycylindrical vs faceted geometric diffuser),
// so we sub-discriminate by entry id pattern when the category alone
// isn't specific enough.
// ---------------------------------------------------------------------

// Pure — returns a fresh THREE.Group every call, no module-scope side
// effects. Safe to import from outside SurfaceLAB. RoomLAB's
// _buildTreatmentMesh in js/graphics/scene.js consumes this so placed
// treatments render with the same procedural geometry as the SurfaceLAB
// preview (QRD wells, foam wedges, polycyl arcs, etc.) instead of a
// flat BoxGeometry. Builder convention: back face of the panel sits at
// local z=0, body extends into +Z. RoomLAB places the wrapper Group so
// its local +Z aligns with the inward wall normal — no extra offset.
export function buildSampleGroup(entry) {
  const g = _dispatchBuilder(entry);
  // Enforce panel convention: bbox back face at local z=0, body extends
  // into +Z. The per-builder code has historically been inconsistent
  // (QRD centres itself at z=D/2; others centre at z=0). RoomLAB's
  // placer expects back-flush so the panel sits on the wall instead of
  // sinking half its depth into it. SurfaceLAB's mountSurfacePreview
  // calls applyAutoFit() afterwards which re-centres X/Z and lifts to
  // stage, so this z-shift is invisible to SurfaceLAB visuals.
  _normalizePanelOriginToBack(g);
  return g;
}

function _dispatchBuilder(entry) {
  const visual = entry.visual || { color: '#888', roughness: 0.85, metalness: 0 };

  // Plain finishes from materials.json always render as textured panels.
  if (entry._source === 'materials' || entry.geometry?.shape === 'sample_panel') {
    return buildTexturedPanel(visual);
  }

  const cat = entry.category || '';
  const id = (entry.id || '').toLowerCase();

  if (cat.startsWith('surface.'))          return buildTexturedPanel(visual);

  if (cat === 'absorber.porous.foam') {
    if (/pyramid/.test(id))                return buildFoamPyramidPanel(entry, visual);
    return buildFoamWedgePanel(entry, visual);
  }
  if (cat === 'absorber.porous.panel')     return buildFabricPanel(entry, visual);
  if (cat === 'absorber.porous.curtain')   return buildFabricPanel(entry, visual);   // stand-in
  if (cat === 'absorber.microperf')        return buildFabricPanel(entry, visual);   // stand-in (perf mask later)

  if (cat === 'bass.porous')               return buildCornerTrap(entry, visual);
  if (cat === 'bass.membrane')             return buildMembraneTrap(entry, visual);
  if (cat === 'bass.helmholtz')            return buildMembraneTrap(entry, visual);  // similar cabinet look
  if (cat === 'bass.tuned_array')          return buildMembraneTrap(entry, visual);

  if (cat === 'diffuser.qrd_1d')           return buildQRDPanel(entry, false, visual);
  if (cat === 'diffuser.qrd_2d')           return buildQRDPanel(entry, true,  visual);
  if (cat === 'diffuser.parametric')       return buildQRDPanel(entry, false, visual);   // non-prime well sequence
  if (cat === 'diffuser.hybrid')           return buildBADPanel(entry, visual);
  if (cat === 'diffuser.geometric') {
    // Polycylindrical (curved) vs faceted-pyramidal (T-Fusor-style)
    if (/t-fusor|fusor|faceted|pyramid/.test(id)) return buildFoamPyramidPanel(entry, visual);
    return buildPolycylPanel(entry, visual);
  }

  // Future branches — placeholder panels until the catalogue ships
  // doors / partitions / etc. Returning a textured panel keeps the
  // viewport populated rather than empty for these empty-day-one
  // categories.
  if (cat.startsWith('opening.'))          return buildTexturedPanel(visual);
  if (cat.startsWith('system.'))           return buildTexturedPanel(visual);

  return buildTexturedPanel(visual);
}

// Shift the group along its local Z so the rear-most vertex lands on
// z=0 (back face flush, body extending into +Z). Measured from a fresh
// world-matrix walk — caller must not have parented the group yet.
function _normalizePanelOriginToBack(g) {
  if (!g) return;
  g.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(g);
  if (bbox.isEmpty()) return;
  g.position.z -= bbox.min.z;
}

// ---------------------------------------------------------------------
// 1. Plain finish — 1m × 1m × 0.04m square panel with a CanvasTexture
//    procedurally drawn from the visual.pattern descriptor.
// ---------------------------------------------------------------------

function buildTexturedPanel(visual) {
  const g = new THREE.Group();
  const W = 0.7, H = 0.7, D = 0.04;
  const tex = makePatternTexture(visual);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: tex,
    roughness: visual.roughness ?? 0.85,
    metalness: visual.metalness ?? 0.0,
  });
  const front = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
  front.position.z = D / 2;
  g.add(front);

  // Slim back box so the sample reads as a panel, not a flat plane.
  const sideMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a, roughness: 0.9, metalness: 0.0,
  });
  const box = new THREE.Mesh(new THREE.BoxGeometry(W, H, D * 0.95), sideMat);
  box.position.z = -D * 0.025;
  g.add(box);
  return g;
}

function makePatternTexture(visual) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = visual.color || '#888';
  ctx.fillRect(0, 0, 512, 512);

  const pattern = visual.pattern;
  if (pattern === 'brick') drawBrickPattern(ctx);
  else if (pattern === 'wood') drawWoodPattern(ctx, visual.color);
  else if (pattern === 'carpet') drawCarpetPattern(ctx, visual.color);
  else if (pattern === 'fabric') drawFabricPattern(ctx, visual.color);
  else drawGrainPattern(ctx, visual.color);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);
  return tex;
}

function drawBrickPattern(ctx) {
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 4;
  const bw = 64, bh = 28;
  for (let row = 0; row < 512 / bh + 1; row++) {
    const y = row * bh;
    const offset = (row % 2) ? bw / 2 : 0;
    ctx.beginPath();
    ctx.moveTo(0, y); ctx.lineTo(512, y); ctx.stroke();
    for (let col = 0; col < 512 / bw + 2; col++) {
      const x = col * bw + offset;
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x, y + bh); ctx.stroke();
    }
  }
}

function drawWoodPattern(ctx, base) {
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  for (let y = 0; y < 512; y += 3) {
    ctx.beginPath();
    const wave = Math.sin(y * 0.05) * 8;
    ctx.moveTo(wave, y);
    ctx.bezierCurveTo(170 + wave, y + 8, 350 - wave, y - 6, 512 + wave, y);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  for (let i = 0; i < 5; i++) {
    const y = 80 + i * 90 + Math.random() * 20;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(170, y + 16, 350, y - 16, 512, y);
    ctx.stroke();
  }
}

function drawCarpetPattern(ctx, base) {
  for (let i = 0; i < 8000; i++) {
    const x = Math.random() * 512, y = Math.random() * 512;
    const shade = Math.random() * 50 - 25;
    ctx.fillStyle = `rgba(${Math.max(0, parseInt(base.slice(1, 3), 16) + shade)},${Math.max(0, parseInt(base.slice(3, 5), 16) + shade)},${Math.max(0, parseInt(base.slice(5, 7), 16) + shade)},0.55)`;
    ctx.fillRect(x, y, 1.6, 1.6);
  }
}

function drawFabricPattern(ctx, base) {
  ctx.globalAlpha = 0.35;
  for (let y = 0; y < 512; y += 2) {
    for (let x = 0; x < 512; x += 2) {
      const t = (x + y) % 4;
      ctx.fillStyle = t < 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.10)';
      ctx.fillRect(x, y, 2, 2);
    }
  }
  ctx.globalAlpha = 1;
}

function drawGrainPattern(ctx, base) {
  ctx.globalAlpha = 0.25;
  for (let i = 0; i < 6000; i++) {
    const x = Math.random() * 512, y = Math.random() * 512;
    const shade = Math.random() * 40 - 20;
    ctx.fillStyle = `rgba(${shade > 0 ? 255 : 0},${shade > 0 ? 255 : 0},${shade > 0 ? 255 : 0},${Math.abs(shade) / 50})`;
    ctx.fillRect(x, y, 1, 1);
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------
// 2a. QRD diffuser — variable-depth wells from prime-root sequence.
//     1D: vertical wells along the X axis.
//     2D (skyline): grid of wells with depths from outer-product of
//     two 1D sequences.
// ---------------------------------------------------------------------

function buildQRDPanel(entry, is2D, visual) {
  const g = new THREE.Group();
  // Schema v2 moved diffuser-specific fields out of entry.geometry into
  // entry.diffuser.{prime_N, period_width_mm, max_well_depth_mm,
  // well_count, fmin_hz, fmax_hz, sequence_type}. Read from the new
  // location first, fall back to entry.geometry (legacy v1) so the
  // builder still works on stale data.
  const wMm = entry.geometry?.width_mm  ?? 600;
  const hMm = entry.geometry?.height_mm ?? 600;
  const dMaxMm = entry.diffuser?.max_well_depth_mm ?? entry.geometry?.max_well_depth_mm ?? entry.geometry?.depth_mm ?? 100;
  const N      = entry.diffuser?.prime_N           ?? entry.geometry?.prime_N           ?? 7;
  const periodWidthMm = entry.diffuser?.period_width_mm ?? entry.geometry?.period_width_mm ?? wMm;
  const wellCount = entry.diffuser?.well_count     ?? entry.geometry?.well_count        ?? 49;

  // Real QRDs repeat the prime-root sequence across multiple periods
  // (e.g. QRD-734: 600 mm panel × 122 mm period → ~5 periods of 7 wells
  // each = 35 wells across). Previously we stretched a single period
  // across the full panel width which made wells look 5× too wide.
  const periodsAcross = Math.max(1, Math.round(wMm / periodWidthMm));
  const wellsAcross = is2D ? Math.max(N, Math.round(Math.sqrt(wellCount))) : (N * periodsAcross);
  const periodsDown = is2D ? periodsAcross : 1;
  const wellsDown   = is2D ? wellsAcross : 1;

  const W = wMm / 1000, H = hMm / 1000, D = dMaxMm / 1000;
  const cellW = W / wellsAcross;
  const cellH = is2D ? H / wellsDown : H;

  const baseMat = new THREE.MeshStandardMaterial({
    color: visual.color, roughness: visual.roughness ?? 0.65, metalness: visual.metalness ?? 0.05,
  });
  const finMat = new THREE.MeshStandardMaterial({
    color: 0x202020, roughness: 0.9, metalness: 0.0,
  });

  // Backer plate so the wells have a visible bottom.
  const backer = new THREE.Mesh(new THREE.BoxGeometry(W, H, D * 0.05), finMat);
  backer.position.z = -D / 2 - D * 0.025;
  g.add(backer);

  for (let i = 0; i < wellsAcross; i++) {
    for (let j = 0; j < wellsDown; j++) {
      const seqI = (i * i) % N;
      const seqJ = is2D ? (j * j) % N : 0;
      const seqVal = is2D ? (seqI + seqJ) % N : seqI;
      const wellDepth = (seqVal / (N - 1)) * D;
      const blockDepth = D - wellDepth;
      if (blockDepth < 0.001) continue;
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(cellW * 0.96, cellH * 0.96, blockDepth),
        baseMat,
      );
      const x = -W / 2 + cellW * (i + 0.5);
      const y = is2D ? -H / 2 + cellH * (j + 0.5) : 0;
      const z = -D / 2 + blockDepth / 2;
      block.position.set(x, y, z);
      g.add(block);
    }
  }
  // Centre on origin
  g.position.z = D / 2;
  return g;
}

// ---------------------------------------------------------------------
// 2b. Polycylindrical diffuser — curved surface, single arc.
// ---------------------------------------------------------------------

function buildPolycylPanel(entry, visual) {
  const g = new THREE.Group();
  const W = (entry.geometry?.width_mm  ?? 600) / 1000;
  const H = (entry.geometry?.height_mm ?? 600) / 1000;
  // Schema v2: radius_mm / rise_mm moved to entry.diffuser.*; fall back
  // to entry.geometry for legacy data.
  const radius = (entry.diffuser?.radius_mm ?? entry.geometry?.radius_mm ?? 450) / 1000;
  const rise   = (entry.diffuser?.rise_mm   ?? entry.geometry?.rise_mm   ?? 100) / 1000;
  const segments = 32;

  const halfChord = W / 2;
  const arcAngle = 2 * Math.asin(Math.min(1, halfChord / radius));
  const startAngle = Math.PI / 2 - arcAngle / 2;

  const verts = [];
  const indices = [];
  // Build the curved front surface: rows of vertices stepping along
  // the arc + along the height.
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const a = startAngle + t * arcAngle;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius - radius + rise;
    for (let j = 0; j <= 1; j++) {
      const y = -H / 2 + j * H;
      verts.push(x, y, z);
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = (i + 1) * 2;
    indices.push(a, a + 1, b);
    indices.push(b, a + 1, b + 1);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: visual.color, roughness: visual.roughness ?? 0.6, metalness: visual.metalness ?? 0.05,
    side: THREE.DoubleSide,
  });
  g.add(new THREE.Mesh(geom, mat));

  // Backer plate
  const backer = new THREE.Mesh(
    new THREE.BoxGeometry(W, H, 0.01),
    new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.9 }),
  );
  backer.position.z = -0.005;
  g.add(backer);
  return g;
}

// ---------------------------------------------------------------------
// 2c. Hybrid B.A.D. panel — flat panel with binary perforation pattern.
// ---------------------------------------------------------------------

function buildBADPanel(entry, visual) {
  const g = new THREE.Group();
  const W = (entry.geometry?.width_mm  ?? 600) / 1000;
  const H = (entry.geometry?.height_mm ?? 600) / 1000;
  const D = (entry.geometry?.depth_mm  ?? 50) / 1000;

  const baseMat = new THREE.MeshStandardMaterial({
    color: visual.color, roughness: 0.7, metalness: 0.05,
  });
  const fabricMat = new THREE.MeshStandardMaterial({
    color: 0x322f2c, roughness: 0.95, metalness: 0.0,
  });
  // Fabric back — spans z = [-D*0.7, 0]
  const fabric = new THREE.Mesh(new THREE.BoxGeometry(W, H, D * 0.7), fabricMat);
  fabric.position.z = -D * 0.35;
  g.add(fabric);
  // Front mask — binary tiles, each block thickness D*0.25 sitting
  // flush on the fabric front (z=0). Block centred at z=D*0.125 →
  // spans [0, D*0.25]. The previous z=D*0.15 left a 0.025·D gap
  // behind the blocks (Viktor audit).
  const cells = 12;
  const cellW = W / cells, cellH = H / cells;
  const blockThickness = D * 0.25;
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      // pseudo-binary mask via hash — not a real binary-Schroeder
      // sequence, but visually plausible for the catalogue preview.
      const on = ((i * 13 + j * 7) % 5) < 3;
      if (!on) continue;
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(cellW * 0.92, cellH * 0.92, blockThickness),
        baseMat,
      );
      block.position.set(
        -W / 2 + cellW * (i + 0.5),
        -H / 2 + cellH * (j + 0.5),
         blockThickness / 2,            // flush on fabric front at z=0
      );
      g.add(block);
    }
  }
  return g;
}

// ---------------------------------------------------------------------
// 2d. Foam wedge / pyramid — arrays of small wedge / pyramid tiles.
// ---------------------------------------------------------------------

function buildFoamWedgePanel(entry, visual) {
  const g = new THREE.Group();
  const W = (entry.geometry?.width_mm  ?? 610) / 1000;
  const H = (entry.geometry?.height_mm ?? 610) / 1000;
  const D = (entry.geometry?.depth_mm  ?? 50) / 1000;

  const mat = new THREE.MeshStandardMaterial({
    color: visual.color, roughness: 0.95, metalness: 0.0,
  });

  // Backer
  const back = new THREE.Mesh(
    new THREE.BoxGeometry(W, H, D * 0.2),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 }),
  );
  back.position.z = -D * 0.4;
  g.add(back);

  // Each row is a horizontal triangular ridge with apex pointing +Z
  // (out of the panel face toward the viewer). Real Auralex Studiofoam
  // Wedge has the peaks-out-of-the-panel orientation.
  //
  // ExtrudeGeometry produces a prism in shape (X, Y, Z) where Z is the
  // extrude direction. We want the cyclic mapping shape (X,Y,Z) →
  // world (Y, Z, X) so:
  //   shape X (rowH span) → world Y (one row's vertical span)
  //   shape Y (peak)      → world Z (apex toward camera)
  //   shape Z (W)         → world X (ridge runs horizontally)
  //
  // This is a 120° rotation around (1,1,1) and can't be expressed as a
  // single mesh.rotation axis. The previous attempt set rotation.x +
  // rotation.z but Three.js default Euler order 'XYZ' applies Z first
  // (matrix = R_x · R_y · R_z), so the rotation around Z happened in
  // shape-local coordinates and rotated the cross-section the wrong
  // way before X tilted it.
  //
  // Fix: rotate the GEOMETRY itself (vertex-space) with two
  // single-axis steps that compose to the cyclic permutation.
  // rotateY(π/2) then rotateX(π/2) on the geometry maps:
  //   local (1,0,0) → (0,1,0)  ✓
  //   local (0,1,0) → (0,0,1)  ✓
  //   local (0,0,1) → (1,0,0)  ✓
  // Then mesh.rotation is identity, and the translate places each row.
  const rows = 8;
  const rowH = H / rows;
  const peak = D * 0.85;
  const backerFrontZ = -D * 0.3;
  for (let i = 0; i < rows; i++) {
    const yBase = -H / 2 + i * rowH;
    const tri = new THREE.Shape();
    tri.moveTo(0, 0);                 // base bottom
    tri.lineTo(rowH, 0);              // base top
    tri.lineTo(rowH / 2, peak);       // apex toward camera
    tri.lineTo(0, 0);
    const extr = new THREE.ExtrudeGeometry(tri, { depth: W, bevelEnabled: false });
    extr.rotateY(Math.PI / 2);
    extr.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(extr, mat);
    mesh.position.set(-W / 2, yBase, backerFrontZ);
    g.add(mesh);
  }
  return g;
}

function buildFoamPyramidPanel(entry, visual) {
  const g = new THREE.Group();
  const W = (entry.geometry?.width_mm  ?? 610) / 1000;
  const H = (entry.geometry?.height_mm ?? 610) / 1000;
  const D = (entry.geometry?.depth_mm  ?? 100) / 1000;
  const cells = 10;
  const cellW = W / cells, cellH = H / cells;

  const mat = new THREE.MeshStandardMaterial({
    color: visual.color, roughness: 0.95, metalness: 0.0,
  });
  const back = new THREE.Mesh(
    new THREE.BoxGeometry(W, H, D * 0.2),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 }),
  );
  back.position.z = -D * 0.4;
  g.add(back);

  // ConeGeometry(radius, height, 4) is a 4-sided pyramid with apex
  // along +Y by default; corners of the base are at angles 0°, 90°,
  // 180°, 270° around the apex axis — DIAMOND-oriented in the
  // perpendicular plane. Real Auralex Studiofoam Pyramid has
  // axis-aligned bases (edges parallel to panel edges), so we
  // PRE-rotate the geometry 45° around its apex axis (local Y)
  // BEFORE applying the X tilt. Doing it on the geometry side
  // avoids Three.js's Euler order pitfall: with rotation.order =
  // 'XYZ' (default) the matrix is R_x · R_y · R_z, so a rotation.z
  // is applied to the BASE COORDINATES first, BEFORE the X tilt —
  // which tilts the cone's apex axis 45° off +Z instead of
  // rotating around the apex axis. Pre-rotating the geometry
  // sidesteps this entirely.
  //
  // Radius sized so square side = cellW × 0.95 (5% gap between
  // adjacent pyramids for definition). side = R × √2 → R = cellW × 0.67.
  const radius = cellW * 0.67;
  const coneGeom = new THREE.ConeGeometry(radius, D * 0.85, 4);
  coneGeom.rotateY(Math.PI / 4);   // axis-align base around the cone's local Y axis
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const pyr = new THREE.Mesh(coneGeom, mat);
      pyr.rotation.x = Math.PI / 2;     // tilt apex from +Y to +Z (toward camera)
      // Backer spans z = -D*0.5 to z = -D*0.3 (centered at -D*0.4,
      // thickness D*0.2). After rotation.x = +π/2 the cone's base is
      // at local z = -h/2 = -D*0.425 (where h = D*0.85). To sit the
      // pyramid base exactly on the backer front face (z = -D*0.3):
      //   pyr.z = -D*0.3 - (-D*0.425) = D*0.125
      pyr.position.set(
        -W / 2 + cellW * (i + 0.5),
        -H / 2 + cellH * (j + 0.5),
        D * 0.125,
      );
      g.add(pyr);
    }
  }
  return g;
}

// ---------------------------------------------------------------------
// 2e. Fabric-wrapped flat panel (broadband absorber).
// ---------------------------------------------------------------------

function buildFabricPanel(entry, visual) {
  const g = new THREE.Group();
  const W = (entry.geometry?.width_mm  ?? 610) / 1000;
  const H = (entry.geometry?.height_mm ?? 1219) / 1000;
  const D = (entry.geometry?.depth_mm  ?? 51) / 1000;

  // Soft-rounded fabric-wrapped box. Default visual is dark grey
  // fabric — typical broadband-absorber finish.
  const tex = makePatternTexture({ ...visual, pattern: 'fabric' });
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: tex,
    roughness: visual.roughness ?? 0.92, metalness: 0.0,
  });
  const box = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), mat);
  g.add(box);

  // Tiny edge bevel via thin frame
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(W * 1.005, H * 1.005, D * 0.05),
    new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 }),
  );
  frame.position.z = -D / 2;
  g.add(frame);
  // Sizing handled by applyAutoFit() in mountSurfacePreview.
  return g;
}

// ---------------------------------------------------------------------
// 2f. Bass trap — corner wedge (triangular prism) for porous corner
//     traps and soffits; flat membrane box for membrane traps.
// ---------------------------------------------------------------------

function buildCornerTrap(entry, visual) {
  const g = new THREE.Group();
  const w = (entry.geometry?.width_mm  ?? 305) / 1000;
  const h = (entry.geometry?.height_mm ?? 1219) / 1000;
  const d = (entry.geometry?.depth_mm  ?? 305) / 1000;

  // Isoceles wedge with the right-angle corner pointing AWAY from
  // camera (back), and the hypotenuse face front (sloping symmetric
  // sides). Previously the right-angle was at back-left which made
  // the trap look like a wedge-slab rather than a corner trap.
  // Vertices in (X, Z) — the prism is extruded vertically along Y
  // after a -π/2 rotation around X.
  const tri = new THREE.Shape();
  tri.moveTo(-w / 2, -d / 2);      // front-left
  tri.lineTo( w / 2, -d / 2);      // front-right
  tri.lineTo( 0,      d / 2);      // back-centre (apex away from camera)
  tri.lineTo(-w / 2, -d / 2);
  const tex = makePatternTexture({ ...visual, pattern: 'fabric' });
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: tex, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide,
  });
  const extr = new THREE.ExtrudeGeometry(tri, { depth: h, bevelEnabled: false });
  const mesh = new THREE.Mesh(extr, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -h / 2;
  g.add(mesh);
  // Sizing handled by applyAutoFit() in mountSurfacePreview.
  return g;
}

function buildMembraneTrap(entry, visual) {
  const g = new THREE.Group();
  const W = (entry.geometry?.width_mm  ?? 600) / 1000;
  const H = (entry.geometry?.height_mm ?? 600) / 1000;
  const D = (entry.geometry?.depth_mm  ?? 100) / 1000;

  // Membrane face — slightly tinted, low roughness so it reads as
  // a thin diaphragm (plywood/MDF/metal sheet). Cabinet body behind.
  const cabinetMat = new THREE.MeshStandardMaterial({
    color: 0x2c2a28, roughness: 0.85, metalness: 0.05,
  });
  const cabinet = new THREE.Mesh(new THREE.BoxGeometry(W, H, D * 0.95), cabinetMat);
  cabinet.position.z = -D * 0.025;
  g.add(cabinet);

  const membraneMat = new THREE.MeshStandardMaterial({
    color: visual.color || 0x5a5550, roughness: 0.4, metalness: 0.1,
  });
  const membrane = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.96, H * 0.96), membraneMat);
  // Cabinet center at z=-D*0.025, thickness D*0.95 → front face at
  // z = -D*0.025 + D*0.475 = D*0.45. Membrane sits +0.001 in front
  // of that. The previous z=D/2+0.001 left the membrane floating
  // ~5mm in front of the cabinet face (Viktor audit).
  const cabinetFrontZ = D * 0.45;
  membrane.position.z = cabinetFrontZ + 0.001;
  g.add(membrane);

  // Tuning callout — small chrome ring on the face indicating the
  // tuned port position (visual cue, not functional). Sits +0.001 in
  // front of the membrane so it doesn't z-fight.
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(W * 0.04, 32),
    new THREE.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.2, metalness: 0.9 }),
  );
  dot.position.set(W * 0.32, H * 0.32, cabinetFrontZ + 0.002);
  g.add(dot);
  return g;
}

// ---------------------------------------------------------------------
// 2g. Ceiling tile — flat square with a slight surface texture.
// ---------------------------------------------------------------------

function buildCeilingTile(entry, visual) {
  const g = new THREE.Group();
  const W = (entry.geometry?.width_mm  ?? 600) / 1000;
  const H = (entry.geometry?.height_mm ?? 600) / 1000;
  const D = (entry.geometry?.depth_mm  ?? 22) / 1000;

  const tex = makePatternTexture({ ...visual, pattern: 'grain' });
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: tex, roughness: 0.92, metalness: 0.0,
  });
  const tile = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), mat);
  g.add(tile);
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(W * 1.01, H * 1.01, D * 0.4),
    new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.5, metalness: 0.7 }),
  );
  frame.position.z = -D / 2;
  g.add(frame);
  return g;
}
