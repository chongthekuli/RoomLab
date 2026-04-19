import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { state, earHeightFor, getSelectedListener, colorForZone, colorForGroup, expandSources } from '../app-state.js';
import { on } from '../ui/events.js';
import { getCachedLoudspeaker } from '../physics/loudspeaker.js';
import { computeSPLGrid, computeZoneSPLGrid, computeMultiSourceSPL } from '../physics/spl-calculator.js';
import { roomPlanVertices, domeGeometry, isInsideRoom3D } from '../physics/room-shape.js';
import { getMaterialTexture, getMaterialPalette } from './textures.js';

let scene, camera, renderer, controls;
let roomGroup, sourcesGroup, listenersGroup, zonesGroup, heatmapGroup, heatmapMesh;
let materialsRef, container;

// Flip all heatmap visibility in one place. Structural geometry (bowls, walls,
// floor, outlines) stays visible. Kept as a named export so the UI toolbar
// button and any future API can toggle from outside.
export function toggleHeatmaps(force) {
  const next = typeof force === 'boolean' ? force : !state.display.showHeatmaps;
  state.display.showHeatmaps = next;
  if (heatmapGroup) heatmapGroup.visible = next;
  if (heatmapMesh) heatmapMesh.visible = next;
}

export async function mount3DViewport({ materials }) {
  materialsRef = materials;
  container = document.getElementById('view-3d');
  if (!container) return;

  initScene();
  rebuildRoom(true);
  rebuildSources();
  rebuildListeners();
  rebuildZones();
  rebuildHeatmap();
  animate();

  on('room:changed', () => { rebuildRoom(false); rebuildZones(); rebuildHeatmap(); });
  on('source:changed', () => { rebuildSources(); rebuildZones(); rebuildHeatmap(); });
  on('source:model_changed', () => { rebuildSources(); rebuildZones(); rebuildHeatmap(); });
  on('listener:changed', () => { rebuildListeners(); rebuildHeatmap(); });
  on('listener:selected', () => { rebuildListeners(); rebuildHeatmap(); });
  // Preset swap replaces the entire scene; rebuild everything.
  on('scene:reset', () => {
    rebuildRoom(false);
    rebuildSources();
    rebuildListeners();
    rebuildZones();
    rebuildHeatmap();
  });

  window.addEventListener('resize', onResize);
  document.addEventListener('viewport:tab-changed', e => {
    if (e.detail.view === '3d') requestAnimationFrame(onResize);
  });
}

function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1116);

  const w = Math.max(container.clientWidth, 1);
  const h = Math.max(container.clientHeight, 1);

  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 200);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.innerHTML = '';
  container.style.position = 'relative';
  container.appendChild(renderer.domElement);

  // SPL legend overlay (HTML over the WebGL canvas, right side, vertical).
  // Gradient is fixed to the palette used by splColorRGB (60–110 dB range);
  // the displayed min/max labels update dynamically from the current zone grids.
  const legend = document.createElement('div');
  legend.className = 'spl-legend-3d hidden';
  legend.id = 'spl-legend-3d';
  legend.innerHTML = `
    <div class="legend-title">SPL</div>
    <div class="legend-max">— dB</div>
    <div class="legend-bar"></div>
    <div class="legend-min">— dB</div>
  `;
  container.appendChild(legend);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1;
  controls.maxDistance = 80;

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dir = new THREE.DirectionalLight(0xffffff, 0.55);
  dir.position.set(5, 12, 7);
  scene.add(dir);

  const grid = new THREE.GridHelper(40, 40, 0x2a2f38, 0x1a1d22);
  grid.position.y = -0.01;
  scene.add(grid);

  const axes = new THREE.AxesHelper(0.5);
  scene.add(axes);
}

function disposeGroup(g) {
  if (!g) return;
  while (g.children.length) {
    const c = g.children.pop();
    if (c.children && c.children.length) disposeGroup(c);
    c.geometry?.dispose();
    if (c.material) {
      if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
      else c.material.dispose();
    }
  }
}

function colorForAlpha(alpha) {
  if (alpha < 0.10) return 0xd93a3a;
  if (alpha < 0.25) return 0xe6a53a;
  if (alpha < 0.45) return 0xd9c93a;
  if (alpha < 0.65) return 0x7fb85a;
  return 0x3a9e5a;
}

function makeFloorCeilingShape(room) {
  // 2D THREE.Shape in room's (x, y) state coords, centered on origin
  const verts = roomPlanVertices(room);
  const cx = room.width_m / 2, cy = room.depth_m / 2;
  const shape = new THREE.Shape();
  shape.moveTo(verts[0].x - cx, -(verts[0].y - cy));
  for (let i = 1; i < verts.length; i++) {
    shape.lineTo(verts[i].x - cx, -(verts[i].y - cy));
  }
  shape.closePath();
  return shape;
}

function rebuildRoom(isFirst) {
  if (!roomGroup) {
    roomGroup = new THREE.Group();
    scene.add(roomGroup);
  } else {
    disposeGroup(roomGroup);
  }

  const room = state.room;
  const { width_m: w, height_m: h, depth_m: d, surfaces } = room;
  const shape = room.shape ?? 'rectangular';
  const cx = w / 2, cz = d / 2;

  const wallsMatId = surfaces.walls ?? surfaces.wall_north ?? 'gypsum-board';

  // Each surface gets its own textured MeshStandardMaterial. Texture tiling
  // is computed from the surface's real-world dimensions so planks, tiles,
  // and bricks read at correct scale regardless of room size. Walls/ceiling
  // stay slightly translucent so the user can still see the interior from
  // outside; the floor is nearly opaque.
  const buildSurfaceMat = (materialId, widthM, heightM, { opacity = 0.6, doubleSide = true } = {}) => {
    const tex = getMaterialTexture(materialId, widthM, heightM);
    const palette = getMaterialPalette(materialId);
    return new THREE.MeshStandardMaterial({
      map: tex,
      color: palette.tint,
      roughness: palette.roughness,
      metalness: palette.metalness,
      transparent: opacity < 0.99,
      opacity,
      side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    });
  };
  const floorMat = buildSurfaceMat(surfaces.floor, w, d, { opacity: 0.98 });
  const ceilMat  = buildSurfaceMat(surfaces.ceiling, w, d, { opacity: 0.75 });
  const wallsMat = buildSurfaceMat(wallsMatId, (w + d), h, { opacity: 0.85 });

  if (shape === 'rectangular') {
    // Floor + ceiling as rectangular planes
    const floorGeo = new THREE.PlaneGeometry(w, d);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0.001, cz);
    roomGroup.add(floor);

    if (room.ceiling_type !== 'dome') {
      const ceilGeo = new THREE.PlaneGeometry(w, d);
      const ceiling = new THREE.Mesh(ceilGeo, ceilMat);
      ceiling.rotation.x = Math.PI / 2;
      ceiling.position.set(cx, h - 0.001, cz);
      roomGroup.add(ceiling);
    }

    // 4 walls (per-material)
    const wallOpts = [
      [w, h, [cx, h/2, 0],   [0, Math.PI, 0],    surfaces.wall_north],
      [w, h, [cx, h/2, d],   [0, 0, 0],          surfaces.wall_south],
      [d, h, [w,  h/2, cz],  [0, -Math.PI/2, 0], surfaces.wall_east],
      [d, h, [0,  h/2, cz],  [0, Math.PI/2, 0],  surfaces.wall_west],
    ];
    for (const [ww, wh, pos, rot, surfId] of wallOpts) {
      const geo = new THREE.PlaneGeometry(ww, wh);
      const mat = buildSurfaceMat(surfId, ww, wh, { opacity: 0.85 });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(...pos);
      m.rotation.set(...rot);
      m.userData.acoustic_material = surfId;
      roomGroup.add(m);
    }

    // Wireframe edges for shoebox
    const box = new THREE.BoxGeometry(w, h, d);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0xa0a8b4 })
    );
    edges.position.set(cx, h/2, cz);
    roomGroup.add(edges);
    box.dispose();
  } else {
    // Polygon or round: use ShapeGeometry for floor/ceiling (plan shape)
    const planShape = makeFloorCeilingShape(room);
    const floorGeo = new THREE.ShapeGeometry(planShape);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0.001, cz);
    roomGroup.add(floor);

    if (room.ceiling_type !== 'dome') {
      const ceilGeo = new THREE.ShapeGeometry(planShape);
      const ceiling = new THREE.Mesh(ceilGeo, ceilMat);
      ceiling.rotation.x = Math.PI / 2;
      ceiling.position.set(cx, h - 0.001, cz);
      roomGroup.add(ceiling);
    }

    if (shape === 'round') {
      // Cylindrical wall, open-ended. Uses its own material so texture
      // tiling matches the actual circumference (2πr) rather than the
      // rectangular-wall default.
      const r = room.round_radius_m ?? 3;
      const cylGeo = new THREE.CylinderGeometry(r, r, h, 48, 1, true);
      const cylMat = buildSurfaceMat(wallsMatId, 2 * Math.PI * r, h, { opacity: 0.85 });
      const cyl = new THREE.Mesh(cylGeo, cylMat);
      cyl.position.set(cx, h/2, cz);
      cyl.userData.acoustic_material = wallsMatId;
      roomGroup.add(cyl);

      // Top and bottom ring edges
      const ringPts = [];
      for (let i = 0; i <= 64; i++) {
        const a = i * 2 * Math.PI / 64;
        ringPts.push(new THREE.Vector3(cx + r * Math.cos(a), 0, cz + r * Math.sin(a)));
      }
      const bottomRing = new THREE.BufferGeometry().setFromPoints(ringPts);
      roomGroup.add(new THREE.Line(bottomRing, new THREE.LineBasicMaterial({ color: 0xa0a8b4 })));
      const topPts = ringPts.map(p => new THREE.Vector3(p.x, h, p.z));
      const topRing = new THREE.BufferGeometry().setFromPoints(topPts);
      roomGroup.add(new THREE.Line(topRing, new THREE.LineBasicMaterial({ color: 0xa0a8b4 })));
    } else if (shape === 'custom') {
      // Custom polygon: plane per edge, per-edge materials
      const verts = roomPlanVertices(room);
      const edges = room.surfaces.edges || [];
      const n = verts.length;
      for (let i = 0; i < n; i++) {
        const v1 = verts[i];
        const v2 = verts[(i + 1) % n];
        const ex = v2.x - v1.x, ey = v2.y - v1.y;
        const edgeLen = Math.sqrt(ex * ex + ey * ey);
        if (edgeLen < 0.01) continue;
        const midX = (v1.x + v2.x) / 2;
        const midZ = (v1.y + v2.y) / 2;
        const edgeSurfId = edges[i] ?? 'gypsum-board';
        const geo = new THREE.PlaneGeometry(edgeLen, h);
        const edgeMat = buildSurfaceMat(edgeSurfId, edgeLen, h, { opacity: 0.55 });
        const m = new THREE.Mesh(geo, edgeMat);
        m.position.set(midX, h/2, midZ);
        m.lookAt(cx, h/2, cz);
        m.userData.acoustic_material = edgeSurfId;
        roomGroup.add(m);
      }
      const bottom = verts.map(v => new THREE.Vector3(v.x, 0, v.y));
      bottom.push(bottom[0]);
      const top = verts.map(v => new THREE.Vector3(v.x, h, v.y));
      top.push(top[0]);
      roomGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(bottom), new THREE.LineBasicMaterial({ color: 0xa0a8b4 })));
      roomGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(top), new THREE.LineBasicMaterial({ color: 0xa0a8b4 })));
      for (let i = 0; i < n; i++) {
        const pts = [
          new THREE.Vector3(verts[i].x, 0, verts[i].y),
          new THREE.Vector3(verts[i].x, h, verts[i].y),
        ];
        roomGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xa0a8b4 })));
      }
    } else {
      // Polygon walls: N plane segments around the ring.
      // If stadiumStructure.vomitories is defined, skip wall segments whose midpoints
      // fall inside any vomitory's angular range — creating physical openings.
      const n = room.polygon_sides ?? 6;
      const verts = roomPlanVertices(room);
      const vomAnglesRad = (room.stadiumStructure?.vomitories?.centerAnglesDeg || [])
        .map(a => a * Math.PI / 180);
      const vomHalfWidth = ((room.stadiumStructure?.vomitories?.widthDeg || 0) / 2) * Math.PI / 180;
      const segmentInVomitory = (midX, midZ) => {
        if (vomAnglesRad.length === 0 || vomHalfWidth <= 0) return false;
        const angle = Math.atan2(midZ - cz, midX - cx);
        // Small epsilon so segment midpoints that fall exactly at the vomitory
        // half-width boundary (common with matched polygon/vomitory resolutions,
        // e.g., 36-gon + 10° vomitory → midpoints at ±5°) are counted as inside.
        const eps = 0.01;
        for (const vc of vomAnglesRad) {
          let diff = angle - vc;
          while (diff >  Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;
          if (Math.abs(diff) < vomHalfWidth + eps) return true;
        }
        return false;
      };
      // In vomitory angular range, wall is partial: spans from tunnel ceiling
      // (z = concourse elevation, typically 3.25 m) to the dome (z = h). Below
      // the tunnel ceiling is the portal. Outside vomitory range, wall is full height.
      const TUNNEL_CEILING_Z = room.stadiumStructure?.concourse?.elevation_m ?? 3.25;
      for (let i = 0; i < n; i++) {
        const v1 = verts[i];
        const v2 = verts[(i + 1) % n];
        const ex = v2.x - v1.x, ey = v2.y - v1.y;
        const edgeLen = Math.sqrt(ex * ex + ey * ey);
        const midX = (v1.x + v2.x) / 2;
        const midZ = (v1.y + v2.y) / 2;
        const inVom = segmentInVomitory(midX, midZ);
        const wallBottom = inVom ? TUNNEL_CEILING_Z : 0;
        const wallTop = h;
        const wallH = wallTop - wallBottom;
        if (wallH <= 0.01) continue;
        const geo = new THREE.PlaneGeometry(edgeLen, wallH);
        // Per-segment textured material so each wall panel's tiling matches
        // its own dimensions (seams stay square instead of stretching).
        const segMat = buildSurfaceMat(wallsMatId, edgeLen, wallH, { opacity: 0.85 });
        const m = new THREE.Mesh(geo, segMat);
        const midY = (wallBottom + wallTop) / 2;
        m.position.set(midX, midY, midZ);
        m.lookAt(cx, midY, cz);
        m.userData.acoustic_material = wallsMatId;
        m.userData.tag = inVom ? 'wall_above_tunnel' : 'wall';
        roomGroup.add(m);
      }

      // Wireframe edges around polygon
      const bottom = verts.map(v => new THREE.Vector3(v.x, 0, v.y));
      bottom.push(bottom[0]);
      const top = verts.map(v => new THREE.Vector3(v.x, h, v.y));
      top.push(top[0]);
      roomGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(bottom),
        new THREE.LineBasicMaterial({ color: 0xa0a8b4 })
      ));
      roomGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(top),
        new THREE.LineBasicMaterial({ color: 0xa0a8b4 })
      ));
      // Vertical edges
      for (let i = 0; i < n; i++) {
        const pts = [
          new THREE.Vector3(verts[i].x, 0, verts[i].y),
          new THREE.Vector3(verts[i].x, h, verts[i].y),
        ];
        roomGroup.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: 0xa0a8b4 })
        ));
      }
    }
  }

  // Dome cap (any shape)
  const dome = domeGeometry(room);
  if (dome) {
    const { sphereRadius, rise, thetaMax } = dome;
    const capGeo = new THREE.SphereGeometry(sphereRadius, 48, 24, 0, Math.PI * 2, 0, thetaMax);
    const cap = new THREE.Mesh(capGeo, ceilMat);
    cap.position.set(cx, h + rise - sphereRadius, cz);
    cap.userData.acoustic_material = surfaces.ceiling;
    roomGroup.add(cap);
  }

  // Tag floor + walls with their acoustic material for future ray tracing.
  // Labels here identify the Three.js object class in the scene graph; the actual
  // absorption coefficients come from the material id in state.room.surfaces.
  for (const m of roomGroup.children) {
    if (!m.userData.acoustic_material) {
      // Default tag based on position: y≈0 is floor, upper shell is ceiling, else wall.
      // rebuildRoom only puts floor/ceiling/walls in roomGroup, so this is safe.
      m.userData.acoustic_material = m.userData.acoustic_material ?? wallsMatId;
    }
  }

  // Solid stadium bowl structures (LatheGeometry) if the preset provides stadiumStructure.
  rebuildBowlStructure(room);

  if (isFirst && controls) {
    const d3 = Math.max(w, h, d);
    camera.position.set(cx + d3 * 0.9, h + d3 * 0.5, d + d3 * 0.4);
    controls.target.set(cx, h * 0.4, cz);
    controls.update();
  }
}

// Cabinet dimensions in meters by speaker type. Line-array elements are
// scaled slightly larger than real-world (~1.2m × 0.42m × 0.7m, vs Nexo STM
// M46 at 1.28 × 0.48 × 0.69) so they remain readable from arena-scale camera
// distances. Visual-only — physics still runs against the loudspeaker JSON
// directivity.
function speakerCabinetDims(modelUrl) {
  const url = modelUrl || '';
  // Depth reduced to 0.45 m (from 0.70) so the cabinet reads as a thin box
  // rather than a deep wedge — feedback: "back big, front small" was
  // perspective foreshortening on a deep cabinet when tilted down. At
  // d≈h=0.42 m the top and front faces are similar in size so perspective
  // doesn't mislead. Still wider than real Nexo/K2 (0.65 m) but acceptable
  // for a visual simulator.
  if (/line-array/i.test(url))  return { w: 1.20, h: 0.42, d: 0.45, type: 'line-array' };
  if (/compact-6/i.test(url))   return { w: 0.24, h: 0.36, d: 0.24, type: 'compact' };
  return { w: 0.42, h: 0.66, d: 0.38, type: 'cabinet' };
}

// Trapezoidal prism — front face (at local -Z) full size, back face (at +Z)
// shorter in height, centered vertically. Gives the unmistakable wedge
// silhouette of a pro line-array element: angled top slopes down toward the
// back, angled bottom slopes up toward the back. With splay=0.55 the back is
// 45% of the front height — visible from any viewing angle.
function buildWedgeGeometry(w, h, d, splay = 0.55) {
  const hf = h / 2;                  // front half-height (full)
  const hb = h * (1 - splay) / 2;    // back half-height (shorter, centered)
  const wf = w / 2;
  const verts = new Float32Array([
    // 0..3  front face (local -Z)
    -wf, -hf, -d/2,
     wf, -hf, -d/2,
     wf,  hf, -d/2,
    -wf,  hf, -d/2,
    // 4..7  back face (local +Z) — shorter height, centered at y=0
    -wf, -hb,  d/2,
     wf, -hb,  d/2,
     wf,  hb,  d/2,
    -wf,  hb,  d/2,
  ]);
  const indices = [
    0, 3, 2,  0, 2, 1,   // front (-Z normal)
    4, 5, 6,  4, 6, 7,   // back  (+Z normal)
    3, 7, 6,  3, 6, 2,   // top (sloped)
    0, 1, 5,  0, 5, 4,   // bottom (sloped)
    0, 4, 7,  0, 7, 3,   // left (trapezoid)
    1, 2, 6,  1, 6, 5,   // right (trapezoid)
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// Paints visible driver details on the front grille so each cabinet reads as
// "a speaker", not a plain coloured box. Line-array elements get two
// horizontal woofer cones (mid-bass drivers) + a horn waveguide between them;
// conventional cabinets get a large woofer disc + smaller tweeter above.
// Materials are tuned to read against both light and dark backgrounds.
function addDriverDetails(parent, type, w, h, grillZ) {
  const coneMat = new THREE.MeshStandardMaterial({ color: 0x3a3e48, roughness: 0.85, metalness: 0.35 });
  const hornMat = new THREE.MeshStandardMaterial({ color: 0x8a8e98, roughness: 0.3, metalness: 0.85 });
  const rimMat  = new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.95, metalness: 0.05 });
  if (type === 'line-array') {
    // Upper woofer — slightly protruding cone on the baffle.
    const wofferW = w * 0.78, wofferH = h * 0.30;
    const upper = new THREE.Mesh(new THREE.BoxGeometry(wofferW, wofferH, 0.02), coneMat);
    upper.position.set(0, h * 0.22, grillZ - 0.011);
    parent.add(upper);
    // Lower woofer
    const lower = new THREE.Mesh(new THREE.BoxGeometry(wofferW, wofferH, 0.02), coneMat);
    lower.position.set(0, -h * 0.22, grillZ - 0.011);
    parent.add(lower);
    // Central horn waveguide — bright metallic, clearly visible.
    const horn = new THREE.Mesh(new THREE.BoxGeometry(w * 0.62, h * 0.14, 0.025), hornMat);
    horn.position.set(0, 0, grillZ - 0.014);
    parent.add(horn);
    // Thin dark bezels around each woofer
    const bezelU = new THREE.Mesh(new THREE.BoxGeometry(wofferW + 0.02, wofferH + 0.015, 0.01), rimMat);
    bezelU.position.set(0, h * 0.22, grillZ - 0.005);
    parent.add(bezelU);
    const bezelL = new THREE.Mesh(new THREE.BoxGeometry(wofferW + 0.02, wofferH + 0.015, 0.01), rimMat);
    bezelL.position.set(0, -h * 0.22, grillZ - 0.005);
    parent.add(bezelL);
  } else {
    // Main woofer (circle)
    const woofer = new THREE.Mesh(new THREE.CircleGeometry(Math.min(w, h) * 0.36, 24), coneMat);
    woofer.position.set(0, -h * 0.12, grillZ - 0.008);
    parent.add(woofer);
    // Tweeter
    const tweeter = new THREE.Mesh(new THREE.CircleGeometry(Math.min(w, h) * 0.14, 20), hornMat);
    tweeter.position.set(0, h * 0.26, grillZ - 0.008);
    parent.add(tweeter);
  }
}

// Builds a speaker enclosure group oriented so its front face (local -Z) points
// along the aim vector. Used by both lookAt() + optional roll-about-aim.
function buildSpeakerEnclosure(src, groupInt, outside) {
  const dims = speakerCabinetDims(src.modelUrl);
  const { w, h, d, type } = dims;

  // Matte-black cabinet body. Line-array elements are RECTANGULAR boxes
  // (stacking flat face-to-face is the point of a line array — the wedge
  // was confusing the visual). Conventional cabinets get a subtle taper.
  const bodyColor = outside ? 0x6a1a0c : 0x1a1d22;
  const bodyGeo = type === 'line-array'
    ? new THREE.BoxGeometry(w, h, d)
    : buildWedgeGeometry(w, h, d, 0.10);
  const body = new THREE.Mesh(
    bodyGeo,
    new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.72, metalness: 0.3 }),
  );

  // Bright edge lines around each cabinet so the rectangular outline is
  // unmistakable even at arena camera distance. For line-arrays this proves
  // each element is a box (not a wedge) even when the stack has J-curve
  // splay that can look wedge-shaped in the silhouette.
  const edgeColor = outside ? 0xff9a66 : 0xeef0f4;
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(bodyGeo, 15),
    new THREE.LineBasicMaterial({ color: edgeColor }),
  );

  // Baffle/grille panel flush with the front face, tinted by speaker group.
  const grillColor = outside ? 0xff5a3c : (groupInt ?? 0x4a515b);
  const grillEmissive = outside ? 0x551100 : (groupInt ? (groupInt & 0x2a2a2a) : 0x141414);
  const baffleZ = -d / 2 - 0.002;
  const grill = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 0.94, h * 0.92),
    new THREE.MeshStandardMaterial({
      color: grillColor, roughness: 0.9, metalness: 0.05, emissive: grillEmissive,
      side: THREE.DoubleSide,
    }),
  );
  grill.position.set(0, 0, baffleZ);
  grill.rotation.y = Math.PI; // face -Z

  const encl = new THREE.Group();
  encl.add(body);
  encl.add(edges);
  encl.add(grill);
  addDriverDetails(encl, type, w, h, baffleZ);

  // Rigging pin on top-back corner of the cabinet (real line-array rigging
  // lives at the top-back — that's the pivot point around which splay is
  // applied). Put it at local +Z = back side, slightly inboard from the
  // corner so the rail threading through it reads cleanly.
  if (type === 'line-array') {
    const pinZ = d * 0.42;  // near the back face (local +Z)
    const rig = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 14, 14),
      new THREE.MeshStandardMaterial({ color: 0xc79bff, emissive: 0x4a1a88, roughness: 0.35, metalness: 0.6 }),
    );
    rig.position.set(0, h / 2 + 0.06, pinZ);
    encl.add(rig);
    const pin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.014, 0.014, 0.08, 10),
      new THREE.MeshStandardMaterial({ color: 0x989ba2, metalness: 0.85, roughness: 0.25 }),
    );
    pin.position.set(0, h / 2 + 0.02, pinZ);
    encl.add(pin);
  }

  encl.userData.acoustic_material = 'speaker_cabinet';
  encl.userData.speaker_type = type;
  return encl;
}

function rebuildSources() {
  if (!sourcesGroup) {
    sourcesGroup = new THREE.Group();
    scene.add(sourcesGroup);
  } else {
    disposeGroup(sourcesGroup);
  }

  // Visual rigging for each line-array hang: a top frame bar + a thick
  // backbone rail that threads through every element's rigging pin so the
  // column reads as ONE physical hang (not N floating boxes).
  for (const src of state.sources) {
    if (src.kind !== 'line-array') continue;
    const origin = src.origin ?? { x: 0, y: 0, z: 0 };
    const elements = expandSources([src]);
    const groupHex = src.groupId ? colorForGroup(src.groupId) : null;
    const groupInt = groupHex ? parseInt(groupHex.slice(1), 16) : null;

    // Top rigging frame bar (the horizontal flying frame in EASE Focus).
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.12, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x2a2d34, roughness: 0.5, metalness: 0.75 }),
    );
    frame.position.set(origin.x, origin.z + 0.5, origin.y);
    // Rotate flying frame to align with the hang's yaw.
    frame.rotation.y = -(src.baseYaw_deg ?? 0) * Math.PI / 180;
    sourcesGroup.add(frame);
    // Motor chain hoist above the frame
    const motor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 0.4, 10),
      new THREE.MeshStandardMaterial({ color: 0x888b92, roughness: 0.4, metalness: 0.8 }),
    );
    motor.position.set(origin.x, origin.z + 0.8, origin.y);
    sourcesGroup.add(motor);

    // Thick backbone rail — one visible Tube connecting frame bottom
    // through every element rig point to the last element's bottom.
    // Drawn as a short cylinder between each pair of consecutive rig points.
    const railMat = new THREE.MeshStandardMaterial({
      color: groupInt ?? 0x444850, roughness: 0.4, metalness: 0.85,
    });
    const topPt = new THREE.Vector3(origin.x, origin.z + 0.4, origin.y);
    const pts = [topPt];
    for (const el of elements) {
      pts.push(new THREE.Vector3(el.rigPoint.x, el.rigPoint.z, el.rigPoint.y));
    }
    // Extend past the last element by half-spacing along the last down-vector
    // so the rail visually enters the bottom element.
    const last = elements[elements.length - 1];
    if (last) {
      const pRad = last.aim.pitch * Math.PI / 180;
      const yRad = (src.baseYaw_deg ?? 0) * Math.PI / 180;
      const sp = src.elementSpacing_m ?? 0.42;
      const dx = sp * Math.sin(yRad) * Math.sin(pRad);
      const dy = sp * Math.cos(yRad) * Math.sin(pRad);
      const dz = -sp * Math.cos(pRad);
      pts.push(new THREE.Vector3(
        last.rigPoint.x + dx,
        last.rigPoint.z + dz,
        last.rigPoint.y + dy,
      ));
    }
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const len = a.distanceTo(b);
      if (len < 0.01) continue;
      const seg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, len, 6),
        railMat,
      );
      // Cylinder default axis is +Y. Orient from a to b.
      seg.position.copy(a).addScaledVector(new THREE.Vector3().subVectors(b, a), 0.5);
      seg.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3().subVectors(b, a).normalize(),
      );
      sourcesGroup.add(seg);
    }
  }

  for (const src of expandSources(state.sources)) {
    const outside = !isInsideRoom3D(src.position, state.room);
    const groupHex = src.groupId ? colorForGroup(src.groupId) : null;
    const groupInt = groupHex ? parseInt(groupHex.slice(1), 16) : null;

    const encl = buildSpeakerEnclosure(src, groupInt, outside);
    encl.position.set(src.position.x, src.position.z, src.position.y);

    // Orient via lookAt so line-array boxes stay horizontally level even at
    // non-zero pitch (unlike setFromUnitVectors which can roll the box).
    const yaw = src.aim.yaw * Math.PI / 180;
    const pitch = src.aim.pitch * Math.PI / 180;
    const aimX = Math.sin(yaw) * Math.cos(pitch);
    const aimY = Math.sin(pitch);
    const aimZ = Math.cos(yaw) * Math.cos(pitch);
    encl.lookAt(
      encl.position.x + aimX,
      encl.position.y + aimY,
      encl.position.z + aimZ,
    );
    // Optional roll about the aim axis (rotation around local -Z which now
    // points along the aim direction after lookAt).
    if (src.aim.roll) {
      encl.rotateOnAxis(new THREE.Vector3(0, 0, -1), src.aim.roll * Math.PI / 180);
    }
    sourcesGroup.add(encl);

    // Group indicator ring on the floor below the speaker — helpful for
    // ground-placed speakers. Skip for line-array elements (they all share
    // one origin/hang, so N overlapping rings just make noise).
    if (groupInt && !outside && !src.arrayId) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.35, 0.04, 8, 32),
        new THREE.MeshBasicMaterial({ color: groupInt }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(src.position.x, 0.02, src.position.y);
      sourcesGroup.add(ring);
    }
  }
}

function rebuildListeners() {
  if (!listenersGroup) {
    listenersGroup = new THREE.Group();
    scene.add(listenersGroup);
  } else {
    disposeGroup(listenersGroup);
  }

  for (const lst of state.listeners) {
    const isSel = lst.id === state.selectedListenerId;
    const ear = earHeightFor(lst);
    const bodyColor = isSel ? 0xffd000 : 0x4a8ff0;
    const headColor = isSel ? 0xffd000 : 0xffc59e;

    let bodyBottom = 0;
    if (lst.posture === 'sitting_chair') bodyBottom = 0.45;

    const bodyTop = ear - 0.12;
    const bodyH = Math.max(bodyTop - bodyBottom, 0.1);

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.17, 0.17, bodyH, 14),
      new THREE.MeshStandardMaterial({ color: bodyColor })
    );
    body.position.set(lst.position.x, bodyBottom + bodyH / 2, lst.position.y);
    listenersGroup.add(body);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 14, 14),
      new THREE.MeshStandardMaterial({ color: headColor })
    );
    head.position.set(lst.position.x, ear, lst.position.y);
    listenersGroup.add(head);

    if (lst.posture === 'sitting_chair') {
      const chair = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.45, 0.5),
        new THREE.MeshStandardMaterial({ color: 0x6a6a6a, transparent: true, opacity: 0.7 })
      );
      chair.position.set(lst.position.x, 0.225, lst.position.y);
      listenersGroup.add(chair);
    }
  }
}

function rebuildZones() {
  if (!zonesGroup) {
    zonesGroup = new THREE.Group();
    scene.add(zonesGroup);
  } else {
    disposeGroup(zonesGroup);
  }
  // Heatmap planes live in their own group so the toolbar toggle can flip
  // visibility without touching the structural outlines/catwalk that stay in zonesGroup.
  if (!heatmapGroup) {
    heatmapGroup = new THREE.Group();
    scene.add(heatmapGroup);
  } else {
    disposeGroup(heatmapGroup);
  }
  state.results.zoneGrids = [];
  if (!state.zones || state.zones.length === 0) {
    heatmapGroup.visible = state.display.showHeatmaps;
    return;
  }

  // Arena presets with a stadiumStructure descriptor get the unified mapping
  // surfaces (continuous smooth gradients per bowl sector). Non-arena presets
  // fall through to the legacy per-zone CanvasTexture loop below.
  // expandSources() unpacks any line-array compound entries into their
  // constituent elements so SPL math sees each element as an independent
  // directional source.
  const flatSources = expandSources(state.sources);
  if (state.room.stadiumStructure) {
    if (flatSources.length > 0) {
      rebuildStadiumHeatmap(state.room, flatSources);
    }
    // With or without sources we skip the legacy per-tier loop here — the
    // concrete bowl lathe already shows the seating geometry, and rendering
    // 52 translucent tier patches on top of it looks wrong.
    rebuildStadiumFurniture();
    heatmapGroup.visible = state.display.showHeatmaps;
    updateSPLLegend();
    return;
  }

  for (let zi = 0; zi < state.zones.length; zi++) {
    const zone = state.zones[zi];
    if (!zone.vertices || zone.vertices.length < 3) continue;
    const colorHex = colorForZone(zi);
    const colorInt = parseInt(colorHex.slice(1), 16);

    // Shape centered at its own centroid
    const cx = zone.vertices.reduce((a, v) => a + v.x, 0) / zone.vertices.length;
    const cz = zone.vertices.reduce((a, v) => a + v.y, 0) / zone.vertices.length;
    const shape = new THREE.Shape();
    shape.moveTo(zone.vertices[0].x - cx, -(zone.vertices[0].y - cz));
    for (let i = 1; i < zone.vertices.length; i++) {
      shape.lineTo(zone.vertices[i].x - cx, -(zone.vertices[i].y - cz));
    }
    shape.closePath();

    // SPL heatmap (if sources present).
    // Grid density scales with zone bbox so every heatmap canvas lands roughly
    // at a 0.5 m cell target — the court (28×15 m) gets ~60 cells across,
    // a 1 m tier strip gets just enough samples to read. Cap at 80 so huge
    // zones don't explode into 10k+ samples per frame.
    let heatmapTex = null;
    let splInfo = null;
    if (flatSources.length > 0) {
      const xs = zone.vertices.map(v => v.x);
      const ys = zone.vertices.map(v => v.y);
      const bw = Math.max(...xs) - Math.min(...xs);
      const bd = Math.max(...ys) - Math.min(...ys);
      const adaptiveGrid = Math.max(24, Math.min(80, Math.ceil(Math.max(bw, bd) / 0.5)));
      splInfo = computeZoneSPLGrid({
        zone, sources: flatSources,
        getSpeakerDef: url => getCachedLoudspeaker(url),
        room: state.room, gridSize: adaptiveGrid, freq_hz: 1000, earAbove_m: 1.2,
      });
      if (splInfo && isFinite(splInfo.maxSPL_db)) {
        state.results.zoneGrids.push(splInfo);
        heatmapTex = zoneHeatmapTexture(splInfo);
      }
    }

    // Use ShapeGeometry (exactly matches zone polygon) for both heatmap and fallback cases
    const geo = new THREE.ShapeGeometry(shape);

    if (heatmapTex && splInfo) {
      // Manually UV-map so the heatmap texture aligns with the zone's bbox in state coords
      const [minX, maxX] = splInfo.boundsX;
      const [minY, maxY] = splInfo.boundsY;
      const w = maxX - minX, d = maxY - minY;
      const positions = geo.attributes.position;
      const uvs = new Float32Array(positions.count * 2);
      for (let i = 0; i < positions.count; i++) {
        const lx = positions.getX(i);
        const ly = positions.getY(i);
        // Convert shape-local back to state coords
        const sx = lx + cx;
        const sy = cz - ly;
        uvs[i * 2]     = (sx - minX) / w;
        uvs[i * 2 + 1] = 1 - (sy - minY) / d; // flipY compensation
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

      // Heatmap plane floats at the listener layer (ear height) — the sampled
      // SPL field actually corresponds to splInfo.earZ_m, not the zone floor.
      // Matches EASE/Odeon convention of a separate visualization plane above
      // the structural geometry.
      const mat = new THREE.MeshBasicMaterial({
        map: heatmapTex, transparent: true, opacity: 0.75,
        side: THREE.DoubleSide, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(cx, splInfo.earZ_m, cz);
      mesh.userData.zone_id = zone.id;
      mesh.userData.acoustic_material = zone.material_id ?? null;
      mesh.userData.tag = 'heatmap_layer';
      heatmapGroup.add(mesh);
    } else {
      // No sources / no SPL yet: fall back to a translucent colored patch at
      // the structural floor so the user can still see zone extents. Lives in
      // zonesGroup (structural overlay) — not toggled by the heatmap switch.
      const mat = new THREE.MeshStandardMaterial({
        color: colorInt, transparent: true, opacity: 0.4, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(cx, zone.elevation_m + 0.05, cz);
      mesh.userData.zone_id = zone.id;
      mesh.userData.acoustic_material = zone.material_id ?? null;
      zonesGroup.add(mesh);
    }

    // Per-zone colored outlines were removed: they created a cluttered rainbow
    // wireframe over every seating step. The solid bowl geometry already shows
    // step boundaries, and the heatmap texture shows zone extents when ON.
  }

  rebuildStadiumFurniture();
  heatmapGroup.visible = state.display.showHeatmaps;
  updateSPLLegend();
}

// -----------------------------------------------------------------------------
// Unified arena heatmap — EASE/Odeon-style continuous mapping surfaces.
//
// Instead of drawing one thin textured strip per seating tier (the stripe-
// artifact problem reviewers flagged), we build ONE inclined surface per bowl
// sector that follows the mean seating rake, sample SPL on a dense
// per-vertex grid, and let Three.js interpolate colors across triangles.
//
// One surface per lower-bowl sector (4), per upper-bowl sector (4),
// per concourse quadrant (4), plus one for the court. ~13 meshes total,
// all in heatmapGroup so the toolbar toggle hides them in one flip.
// -----------------------------------------------------------------------------

// Linear rake z at radius r: interpolates between the first and last tier
// elevations. The solid concrete lathe keeps the actual stepped geometry
// underneath; the mapping surface traces the mean seating plane above it.
function rakeZAtRadius(r, bowl) {
  const tiers = bowl.tier_heights_m;
  const z0 = tiers[0];
  const z1 = tiers[tiers.length - 1];
  if (bowl.r_out <= bowl.r_in) return z0;
  const f = Math.max(0, Math.min(1, (r - bowl.r_in) / (bowl.r_out - bowl.r_in)));
  return z0 + (z1 - z0) * f;
}

// Builds an (radialCells+1) × (arcCells+1) grid of vertices across a ring
// sector. zFn(r) gives the world-Y height at each radius. Returns the
// BufferGeometry plus a parallel array of state-coord listener anchors so
// callers can sample SPL at each vertex.
function buildRingSectorGeometry({ cx, cy, r_in, r_out, phiStart, phiLength, zFn, earAbove = 1.2, liftAbove = 1.2, cellTarget = 0.5, radialMin = 6, radialMax = 40, arcMin = 12, arcMax = 120 }) {
  const radialSpan = r_out - r_in;
  const arcLen = ((r_in + r_out) / 2) * phiLength;
  const radialCells = Math.max(radialMin, Math.min(radialMax, Math.ceil(radialSpan / cellTarget)));
  const arcCells = Math.max(arcMin, Math.min(arcMax, Math.ceil(arcLen / cellTarget)));
  const vertCount = (radialCells + 1) * (arcCells + 1);
  const positions = new Float32Array(vertCount * 3);
  const colors = new Float32Array(vertCount * 3);
  const indices = [];
  const listenerAnchors = new Array(vertCount);

  for (let i = 0; i <= radialCells; i++) {
    const r = r_in + (i / radialCells) * radialSpan;
    const z = zFn(r);
    for (let j = 0; j <= arcCells; j++) {
      const phi = phiStart + (j / arcCells) * phiLength;
      const sx = cx + r * Math.cos(phi);
      const sy = cy + r * Math.sin(phi);
      const idx = i * (arcCells + 1) + j;
      positions[idx * 3 + 0] = sx;
      positions[idx * 3 + 1] = z + liftAbove;
      positions[idx * 3 + 2] = sy;
      listenerAnchors[idx] = { x: sx, y: sy, z: z + earAbove };
    }
  }
  for (let i = 0; i < radialCells; i++) {
    for (let j = 0; j < arcCells; j++) {
      const a = i * (arcCells + 1) + j;
      const b = a + 1;
      const c = (i + 1) * (arcCells + 1) + j;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return { geo, listenerAnchors };
}

// Axis-aligned rectangle grid (used for the court and for any future flat
// audience area). Same vertex-color convention as the ring-sector builder.
function buildRectMappingGeometry({ minX, maxX, minY, maxY, elevation, earAbove = 1.2, liftAbove = 1.2, cellTarget = 0.5 }) {
  const w = maxX - minX, d = maxY - minY;
  const nx = Math.max(12, Math.min(80, Math.ceil(w / cellTarget)));
  const nz = Math.max(12, Math.min(80, Math.ceil(d / cellTarget)));
  const vertCount = (nx + 1) * (nz + 1);
  const positions = new Float32Array(vertCount * 3);
  const colors = new Float32Array(vertCount * 3);
  const indices = [];
  const listenerAnchors = new Array(vertCount);
  for (let i = 0; i <= nx; i++) {
    const sx = minX + (i / nx) * w;
    for (let j = 0; j <= nz; j++) {
      const sy = minY + (j / nz) * d;
      const idx = i * (nz + 1) + j;
      positions[idx * 3 + 0] = sx;
      positions[idx * 3 + 1] = elevation + liftAbove;
      positions[idx * 3 + 2] = sy;
      listenerAnchors[idx] = { x: sx, y: sy, z: elevation + earAbove };
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const a = i * (nz + 1) + j;
      const b = a + 1;
      const c = (i + 1) * (nz + 1) + j;
      const d2 = c + 1;
      indices.push(a, c, b, b, c, d2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return { geo, listenerAnchors };
}

// Fill the color BufferAttribute by sampling SPL at each vertex anchor.
// Returns min/max/avg/uniformity stats for the legend + Results panel.
function sampleSurfaceColors(geo, anchors, sources, room) {
  const colorAttr = geo.attributes.color;
  const getDef = url => getCachedLoudspeaker(url);
  let minSPL = Infinity, maxSPL = -Infinity, sum = 0, count = 0;
  for (let i = 0; i < anchors.length; i++) {
    const spl = computeMultiSourceSPL({
      sources, getSpeakerDef: getDef,
      listenerPos: anchors[i], freq_hz: 1000, room,
    });
    if (isFinite(spl)) {
      if (spl < minSPL) minSPL = spl;
      if (spl > maxSPL) maxSPL = spl;
      sum += spl; count++;
      const [r, g, b] = splColorRGB(spl);
      colorAttr.setXYZ(i, r / 255, g / 255, b / 255);
    } else {
      // No-signal cells (through too many walls etc.) draw dark gray so the
      // surface still reads as a continuous region rather than vanishing.
      colorAttr.setXYZ(i, 0.12, 0.12, 0.14);
    }
  }
  colorAttr.needsUpdate = true;
  return {
    minSPL_db: count > 0 ? minSPL : 0,
    maxSPL_db: count > 0 ? maxSPL : 0,
    avgSPL_db: count > 0 ? sum / count : 0,
    uniformity_db: count > 0 ? maxSPL - minSPL : 0,
    count,
  };
}

// One MeshBasicMaterial shared across every mapping surface — keeps GPU state
// changes low and makes toggle visibility flip cheap.
function makeMappingMaterial() {
  // Opacity reduced so the textured seating/floor material shows through the
  // heatmap — matches the EASE/Odeon look where you can see the audience
  // area's real material under the SPL gradient.
  return new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
}

// Orchestrator: builds the full set of arena mapping surfaces (bowls +
// concourse + court), pushes meshes into heatmapGroup, and writes summary
// rows into state.results.zoneGrids for the Results panel / legend.
function rebuildStadiumHeatmap(room, sources) {
  const s = room.stadiumStructure;
  if (!s) return;
  const vom = s.vomitories;
  if (!vom || !vom.centerAnglesDeg?.length || !(vom.widthDeg > 0)) return;

  const halfWidthRad = (vom.widthDeg / 2) * Math.PI / 180;
  const sorted = [...vom.centerAnglesDeg].sort((a, b) => a - b).map(a => a * Math.PI / 180);
  // Match the sector labeling used in the preset (SE/SW/NW/NE for 4 sectors
  // at ±45° diagonals). Fall back to numeric if the count differs.
  const fallbackLabels = sorted.length === 4 ? ['SE', 'SW', 'NW', 'NE'] : sorted.map((_, i) => `S${i+1}`);
  const material = makeMappingMaterial();

  for (let i = 0; i < sorted.length; i++) {
    const curCenter = sorted[i];
    const nextCenter = sorted[(i + 1) % sorted.length];
    const sectorStart = curCenter + halfWidthRad;
    let sectorEnd = nextCenter - halfWidthRad;
    if (sectorEnd <= sectorStart) sectorEnd += Math.PI * 2;
    const sectorLength = sectorEnd - sectorStart;
    const label = fallbackLabels[i];

    const addSurface = ({ geoPack, id, surfaceLabel, elev }) => {
      const stats = sampleSurfaceColors(geoPack.geo, geoPack.listenerAnchors, sources, room);
      const mesh = new THREE.Mesh(geoPack.geo, material);
      mesh.userData.tag = id;
      mesh.userData.acoustic_material = 'concrete';
      heatmapGroup.add(mesh);
      state.results.zoneGrids.push({
        id, label: surfaceLabel,
        elevation_m: elev, earZ_m: elev + 1.2,
        grid: [], cellsX: 0, cellsY: 0, boundsX: [0,0], boundsY: [0,0],
        cellW_m: 0, cellH_m: 0,
        minSPL_db: stats.minSPL_db, maxSPL_db: stats.maxSPL_db,
        avgSPL_db: stats.avgSPL_db, uniformity_db: stats.uniformity_db,
      });
    };

    // Lower bowl: inclined ring sector at mean rake z.
    const lb = s.lowerBowl;
    if (lb) {
      addSurface({
        geoPack: buildRingSectorGeometry({
          cx: s.cx, cy: s.cy,
          r_in: lb.r_in, r_out: lb.r_out,
          phiStart: sectorStart, phiLength: sectorLength,
          zFn: r => rakeZAtRadius(r, lb),
        }),
        id: `MAP_LB_${label}`,
        surfaceLabel: `Lower ${label}`,
        elev: (lb.tier_heights_m[0] + lb.tier_heights_m[lb.tier_heights_m.length - 1]) / 2,
      });
    }
    // Upper bowl.
    const ub = s.upperBowl;
    if (ub) {
      addSurface({
        geoPack: buildRingSectorGeometry({
          cx: s.cx, cy: s.cy,
          r_in: ub.r_in, r_out: ub.r_out,
          phiStart: sectorStart, phiLength: sectorLength,
          zFn: r => rakeZAtRadius(r, ub),
        }),
        id: `MAP_UB_${label}`,
        surfaceLabel: `Upper ${label}`,
        elev: (ub.tier_heights_m[0] + ub.tier_heights_m[ub.tier_heights_m.length - 1]) / 2,
      });
    }
    // Concourse plateau (flat ring sector).
    const co = s.concourse;
    if (co) {
      addSurface({
        geoPack: buildRingSectorGeometry({
          cx: s.cx, cy: s.cy,
          r_in: co.r_in, r_out: co.r_out,
          phiStart: sectorStart, phiLength: sectorLength,
          zFn: () => co.elevation_m,
          radialMin: 4, radialMax: 16,
        }),
        id: `MAP_CO_${label}`,
        surfaceLabel: `Concourse ${label}`,
        elev: co.elevation_m,
      });
    }
  }

  // Court (flat rectangle). Preset sets id === 'Z_court'; fall back to the
  // first zone at elevation 0 if that id isn't present.
  const courtZone = state.zones.find(z => z.id === 'Z_court')
    ?? state.zones.find(z => (z.elevation_m ?? 0) === 0);
  if (courtZone && courtZone.vertices?.length >= 3) {
    const xs = courtZone.vertices.map(v => v.x);
    const ys = courtZone.vertices.map(v => v.y);
    const pack = buildRectMappingGeometry({
      minX: Math.min(...xs), maxX: Math.max(...xs),
      minY: Math.min(...ys), maxY: Math.max(...ys),
      elevation: courtZone.elevation_m ?? 0,
    });
    const stats = sampleSurfaceColors(pack.geo, pack.listenerAnchors, sources, room);
    const mesh = new THREE.Mesh(pack.geo, material);
    mesh.userData.tag = 'heatmap_court';
    mesh.userData.acoustic_material = courtZone.material_id ?? null;
    heatmapGroup.add(mesh);
    state.results.zoneGrids.push({
      id: courtZone.id, label: courtZone.label ?? 'Court',
      elevation_m: courtZone.elevation_m ?? 0,
      earZ_m: (courtZone.elevation_m ?? 0) + 1.2,
      grid: [], cellsX: 0, cellsY: 0, boundsX: [0,0], boundsY: [0,0],
      cellW_m: 0, cellH_m: 0,
      minSPL_db: stats.minSPL_db, maxSPL_db: stats.maxSPL_db,
      avgSPL_db: stats.avgSPL_db, uniformity_db: stats.uniformity_db,
    });
  }
}

// Builds solid stadium structure (concrete) from room.stadiumStructure.
//
// Uses ONE unified cross-section profile per quadrant that traces:
//   inner wall → lower bowl steps → concourse (horizontal) → upper bowl front wall
//   (vertical rise) → upper bowl steps → back wall (vertical to z=0) →
//   bottom (horizontal back to start).
//
// Revolved per-sector by LatheGeometry with end caps at both phi boundaries
// → each of the 4 quadrants becomes a single watertight solid that includes
// the lower bowl, concourse, upper bowl, and back wall support as one piece.
// Vomitory gaps between quadrants are enclosed separately with tunnel ceilings.
//
// All meshes tagged userData.acoustic_material = 'concrete' for ray tracing.
function rebuildBowlStructure(room) {
  const s = room.stadiumStructure;
  if (!s) return;
  // Clean architectural-model gray. No brown tint — lets the colored heatmap
  // planes read clearly against a neutral base when overlaid, and gives an
  // EASE/Odeon-style monochrome look when the heatmap is toggled off.
  // Concrete texture on the bowl structure for the same architectural-model
  // look the user asked for on walls/floor/ceiling. Tile size matched to the
  // largest bowl dimension so speckle reads consistently across all sectors.
  const bowlRadialSpan = Math.max(1, (s.upperBowl?.r_out ?? 30) * 2);
  const concreteMat = new THREE.MeshStandardMaterial({
    map: getMaterialTexture('concrete-painted', bowlRadialSpan, bowlRadialSpan),
    color: 0xffffff, roughness: 0.88, metalness: 0.02,
    side: THREE.DoubleSide,
  });
  const profile = buildStadiumStructureProfile(s);
  if (!profile) return;

  const vom = s.vomitories;
  if (!vom || !vom.centerAnglesDeg || vom.centerAnglesDeg.length === 0 || !(vom.widthDeg > 0)) {
    // No vomitories: single 360° closed lathe.
    roomGroup.add(buildProfileLatheSector(s.cx, s.cy, profile, concreteMat, 'stadium', 0, Math.PI * 2));
  } else {
    const halfWidthRad = (vom.widthDeg / 2) * Math.PI / 180;
    const sorted = [...vom.centerAnglesDeg].sort((a, b) => a - b).map(a => a * Math.PI / 180);
    for (let i = 0; i < sorted.length; i++) {
      const curCenter = sorted[i];
      const nextCenter = sorted[(i + 1) % sorted.length];
      const sectorStart = curCenter + halfWidthRad;
      let sectorEnd = nextCenter - halfWidthRad;
      if (sectorEnd <= sectorStart) sectorEnd += Math.PI * 2;
      const sectorLength = sectorEnd - sectorStart;
      roomGroup.add(buildProfileLatheSector(s.cx, s.cy, profile, concreteMat, `stadium_sec${i}`, sectorStart, sectorLength));
      roomGroup.add(buildProfileEndCap(s.cx, s.cy, profile, concreteMat, sectorStart, `stadium_cap${i}a`));
      roomGroup.add(buildProfileEndCap(s.cx, s.cy, profile, concreteMat, sectorEnd,   `stadium_cap${i}b`));
    }
  }

  // Tunnel ceilings enclose each vomitory at ~3.5m — arena is otherwise closed above.
  buildTunnelCeilings(room, concreteMat);
}

// Unified closed 2D profile (radius × height) for the whole seating + concourse
// + back wall structure. The cross-section outline starts at the court edge,
// ascends through the lower bowl, crosses the concourse flat, rises to the
// upper bowl front, ascends through the upper bowl, descends vertically via
// the back wall to the ground, then returns horizontally to the start.
function buildStadiumStructureProfile(stadium) {
  const lb = stadium.lowerBowl;
  const ub = stadium.upperBowl;
  if (!lb || !ub) return null;

  const profile = [];
  // Court-edge, floor level
  profile.push(new THREE.Vector2(lb.r_in, 0));
  // Up front of lower bowl tier 1
  profile.push(new THREE.Vector2(lb.r_in, lb.tier_heights_m[0]));
  // Lower bowl: tread → riser pairs
  const lbCount = lb.tier_heights_m.length;
  const lbTread = (lb.r_out - lb.r_in) / lbCount;
  for (let t = 0; t < lbCount; t++) {
    const trEnd = lb.r_in + (t + 1) * lbTread;
    profile.push(new THREE.Vector2(trEnd, lb.tier_heights_m[t]));
    if (t < lbCount - 1) {
      profile.push(new THREE.Vector2(trEnd, lb.tier_heights_m[t + 1]));
    }
  }
  // Concourse horizontal: from (lb.r_out, lb_top) to (ub.r_in, lb_top)
  const concourseZ = lb.tier_heights_m[lbCount - 1];
  profile.push(new THREE.Vector2(ub.r_in, concourseZ));
  // Vertical rise: concourse → upper bowl tier 1 front
  profile.push(new THREE.Vector2(ub.r_in, ub.tier_heights_m[0]));
  // Upper bowl: tread → riser pairs
  const ubCount = ub.tier_heights_m.length;
  const ubTread = (ub.r_out - ub.r_in) / ubCount;
  for (let t = 0; t < ubCount; t++) {
    const trEnd = ub.r_in + (t + 1) * ubTread;
    profile.push(new THREE.Vector2(trEnd, ub.tier_heights_m[t]));
    if (t < ubCount - 1) {
      profile.push(new THREE.Vector2(trEnd, ub.tier_heights_m[t + 1]));
    }
  }
  // Back wall: vertical from upper bowl top outer corner straight down to ground
  profile.push(new THREE.Vector2(ub.r_out, 0));
  // Bottom horizontal back to start (closes the polygon)
  profile.push(new THREE.Vector2(lb.r_in, 0));
  return profile;
}

function buildProfileLatheSector(cx, cy, profile, mat, tag, phi_start_rad, phi_length_rad) {
  const geo = new THREE.LatheGeometry(profile, 24, phi_start_rad, phi_length_rad);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(cx, 0, cy);
  mesh.userData.acoustic_material = 'concrete';
  mesh.userData.tag = tag;
  return mesh;
}

// Flat end-cap face at phi for a sector lathe. Triangulates the 2D profile
// polygon via ShapeGeometry, then rewrites vertex positions from local (r, z)
// to world (cx + r·cos(phi), z, cy + r·sin(phi)). Closes the phi boundary.
function buildProfileEndCap(cx, cy, profile, mat, phi_rad, tag) {
  const shape2d = new THREE.Shape();
  shape2d.moveTo(profile[0].x, profile[0].y);
  for (let i = 1; i < profile.length; i++) {
    shape2d.lineTo(profile[i].x, profile[i].y);
  }
  const geo = new THREE.ShapeGeometry(shape2d);
  const cos_phi = Math.cos(phi_rad);
  const sin_phi = Math.sin(phi_rad);
  const posAttr = geo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const r = posAttr.getX(i);
    const z = posAttr.getY(i);
    posAttr.setXYZ(i, cx + r * cos_phi, z, cy + r * sin_phi);
  }
  posAttr.needsUpdate = true;
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.acoustic_material = 'concrete';
  mesh.userData.tag = tag;
  return mesh;
}

// Flat annular-sector ceiling above each vomitory at z=tunnelCeilingZ.
// Encloses the tunnel from above so the arena is closed everywhere except
// at ground level through the vomitory portals.
function buildTunnelCeilings(room, mat) {
  const s = room.stadiumStructure;
  const vom = s?.vomitories;
  if (!vom || !vom.widthDeg || !vom.centerAnglesDeg?.length) return;
  // Tunnel ceiling sits at the concourse elevation so it aligns cleanly with
  // the walkway behind the lower bowl — no vertical gap between tunnel top and
  // the stadium structure at the sector/vomitory boundary.
  const tunnelZ = s.concourse?.elevation_m ?? 3.25;
  const r_inner = s.lowerBowl?.r_in ?? 15;
  const r_outer = room.polygon_radius_m ?? 30;
  const halfWidthRad = (vom.widthDeg / 2) * Math.PI / 180;
  const arcSteps = 6;

  for (const centerDeg of vom.centerAnglesDeg) {
    const centerRad = centerDeg * Math.PI / 180;
    const ts = centerRad - halfWidthRad;
    const te = centerRad + halfWidthRad;

    // Build ring-sector shape in local coords (centered at origin).
    // Shape y is negated to match the rotation convention used elsewhere.
    const shape = new THREE.Shape();
    const outerPts = [];
    for (let i = 0; i <= arcSteps; i++) {
      const t = ts + (te - ts) * (i / arcSteps);
      outerPts.push({ x: r_outer * Math.cos(t), y: -r_outer * Math.sin(t) });
    }
    shape.moveTo(outerPts[0].x, outerPts[0].y);
    for (let i = 1; i < outerPts.length; i++) shape.lineTo(outerPts[i].x, outerPts[i].y);
    for (let i = arcSteps; i >= 0; i--) {
      const t = ts + (te - ts) * (i / arcSteps);
      shape.lineTo(r_inner * Math.cos(t), -r_inner * Math.sin(t));
    }
    shape.closePath();

    const geo = new THREE.ShapeGeometry(shape);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(s.cx, tunnelZ, s.cy);
    mesh.userData.acoustic_material = 'concrete';
    mesh.userData.tag = `tunnel_ceiling_${centerDeg}`;
    roomGroup.add(mesh);
  }
}

// Overhead catwalk torus (rigging truss). Visual + acoustic reference.
// Called after rebuildZones so zone heatmap planes render first.
function rebuildStadiumFurniture() {
  const s = state.room.stadiumStructure;
  if (!s) return;
  const catwalkHeight = s.catwalkHeight_m ?? (state.room.height_m + 1);
  const catwalkRadius = s.catwalkRadius_m ?? Math.min(state.room.width_m, state.room.depth_m) * 0.2;

  const ctGeo = new THREE.TorusGeometry(catwalkRadius, 0.3, 10, 64);
  const ctMat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.7, roughness: 0.35 });
  const catwalk = new THREE.Mesh(ctGeo, ctMat);
  catwalk.rotation.x = Math.PI / 2;
  catwalk.position.set(s.cx, catwalkHeight, s.cy);
  catwalk.userData.acoustic_material = 'steel';
  catwalk.userData.tag = 'catwalk_truss';
  zonesGroup.add(catwalk);

  // Cables from dome to truss
  const cableMat = new THREE.LineBasicMaterial({ color: 0x666666 });
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const x1 = s.cx + catwalkRadius * Math.cos(ang);
    const z1 = s.cy + catwalkRadius * Math.sin(ang);
    const pts = [
      new THREE.Vector3(x1, catwalkHeight, z1),
      new THREE.Vector3(x1 * 0.65 + s.cx * 0.35, catwalkHeight + 4, z1 * 0.65 + s.cy * 0.35),
    ];
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), cableMat);
    line.userData.acoustic_material = 'steel';
    zonesGroup.add(line);
  }
}

function zoneHeatmapTexture(splInfo) {
  const { grid, cellsX, cellsY } = splInfo;
  const canvas = document.createElement('canvas');
  canvas.width = cellsX;
  canvas.height = cellsY;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cellsX, cellsY);
  for (let j = 0; j < cellsY; j++) {
    for (let i = 0; i < cellsX; i++) {
      const val = grid[j][i];
      const idx = (j * cellsX + i) * 4;
      if (!isFinite(val)) { img.data[idx + 3] = 0; continue; }
      const [r, g, b] = splColorRGB(val);
      img.data[idx + 0] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 210;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

function rebuildHeatmap() {
  if (heatmapMesh) {
    scene.remove(heatmapMesh);
    heatmapMesh.geometry.dispose();
    heatmapMesh.material.map?.dispose();
    heatmapMesh.material.dispose();
    heatmapMesh = null;
  }

  if (state.sources.length === 0) return;
  // When zones exist, they carry per-elevation heatmaps. Skip the room-level plane
  // to avoid a giant translucent disc covering the stacked zone visualization.
  if (state.zones && state.zones.length > 0) return;

  const flat = expandSources(state.sources);
  if (flat.length === 0) return;

  const ear = earHeightFor(getSelectedListener());
  // Adaptive grid so the room-level canvas stays near a 0.5 m cell target
  // (an 8 m studio → 16 cells; a 60 m arena → 80 cells, capped).
  const longestDim = Math.max(state.room.width_m ?? 0, state.room.depth_m ?? 0);
  const roomGrid = Math.max(40, Math.min(120, Math.ceil(longestDim / 0.5)));
  const splResult = computeSPLGrid({
    sources: flat,
    getSpeakerDef: url => getCachedLoudspeaker(url),
    room: state.room, gridSize: roomGrid, freq_hz: 1000, earHeight_m: ear,
  });
  if (!splResult.sourceCount || !isFinite(splResult.maxSPL_db)) return;
  const { grid, cellsX, cellsY } = splResult;

  const canvas = document.createElement('canvas');
  canvas.width = cellsX;
  canvas.height = cellsY;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cellsX, cellsY);

  for (let j = 0; j < cellsY; j++) {
    for (let i = 0; i < cellsX; i++) {
      const val = grid[j][i];
      const idx = (j * cellsX + i) * 4;
      if (!isFinite(val)) {
        img.data[idx + 3] = 0;
        continue;
      }
      const [r, g, b] = splColorRGB(val);
      img.data[idx + 0] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 190;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;

  const { width_m: w, depth_m: d } = state.room;
  const geo = new THREE.PlaneGeometry(w, d);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0.78,
    side: THREE.DoubleSide, depthWrite: false, alphaTest: 0.01,
  });
  heatmapMesh = new THREE.Mesh(geo, mat);
  heatmapMesh.rotation.x = -Math.PI / 2;
  heatmapMesh.position.set(w/2, ear, d/2);
  heatmapMesh.visible = state.display.showHeatmaps;
  scene.add(heatmapMesh);
  updateSPLLegend();
}

// Updates the vertical SPL legend overlay on the 3D viewport.
// Prefers per-zone grid min/max; falls back to the room-level splGrid;
// hides the legend entirely when there is no SPL data to show.
function updateSPLLegend() {
  const legend = document.getElementById('spl-legend-3d');
  if (!legend) return;
  const grids = state.results?.zoneGrids;
  const rg = state.results?.splGrid;
  let minVal = Infinity, maxVal = -Infinity;
  if (grids && grids.length > 0) {
    for (const g of grids) {
      if (isFinite(g.minSPL_db) && g.minSPL_db < minVal) minVal = g.minSPL_db;
      if (isFinite(g.maxSPL_db) && g.maxSPL_db > maxVal) maxVal = g.maxSPL_db;
    }
  } else if (rg && isFinite(rg.minSPL_db) && isFinite(rg.maxSPL_db) && rg.sourceCount > 0) {
    minVal = rg.minSPL_db;
    maxVal = rg.maxSPL_db;
  }
  if (!isFinite(minVal) || !isFinite(maxVal)) {
    legend.classList.add('hidden');
    return;
  }
  legend.classList.remove('hidden');
  legend.querySelector('.legend-max').textContent = maxVal.toFixed(0) + ' dB';
  legend.querySelector('.legend-min').textContent = minVal.toFixed(0) + ' dB';
}

function splColorRGB(spl_db) {
  const t = Math.max(0, Math.min(1, (spl_db - 60) / 50));
  if (t < 0.25) return interpRGB([26, 26, 74], [0, 102, 204], t / 0.25);
  if (t < 0.50) return interpRGB([0, 102, 204], [0, 204, 102], (t - 0.25) / 0.25);
  if (t < 0.75) return interpRGB([0, 204, 102], [255, 204, 0], (t - 0.50) / 0.25);
  return interpRGB([255, 204, 0], [255, 51, 0], (t - 0.75) / 0.25);
}

function interpRGB(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function onResize() {
  if (!container || !renderer || !camera) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function animate() {
  requestAnimationFrame(animate);
  if (!controls || !renderer || !scene || !camera) return;
  controls.update();
  renderer.render(scene, camera);
}
