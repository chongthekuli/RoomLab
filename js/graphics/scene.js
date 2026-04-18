import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { state } from '../app-state.js';
import { on } from '../ui/events.js';
import { getCachedLoudspeaker } from '../physics/loudspeaker.js';
import { computeSPLGrid } from '../physics/spl-calculator.js';

let scene, camera, renderer, controls;
let roomGroup, sourcesGroup, heatmapMesh;
let materialsRef, container;

export async function mount3DViewport({ materials }) {
  materialsRef = materials;
  container = document.getElementById('view-3d');
  if (!container) return;

  initScene();
  rebuildRoom(true);
  rebuildSources();
  rebuildHeatmap();
  animate();

  on('room:changed', () => { rebuildRoom(false); rebuildHeatmap(); });
  on('source:changed', () => { rebuildSources(); rebuildHeatmap(); });
  on('source:model_changed', () => { rebuildSources(); rebuildHeatmap(); });

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
  container.appendChild(renderer.domElement);

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

  // Small world axes near origin for orientation
  const axes = new THREE.AxesHelper(0.5);
  scene.add(axes);
}

function disposeGroup(g) {
  if (!g) return;
  while (g.children.length) {
    const c = g.children.pop();
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

function rebuildRoom(isFirst) {
  if (!roomGroup) {
    roomGroup = new THREE.Group();
    scene.add(roomGroup);
  } else {
    disposeGroup(roomGroup);
  }

  const { width_m: w, height_m: h, depth_m: d, surfaces } = state.room;
  const bandIdx = materialsRef.frequency_bands_hz.indexOf(500);
  const useIdx = bandIdx >= 0 ? bandIdx : 2;
  const alphaOf = id => materialsRef.byId[id]?.absorption[useIdx] ?? 0;

  const mkPlane = (width, height, position, rotation, surfId, opacity) => {
    const geo = new THREE.PlaneGeometry(width, height);
    const mat = new THREE.MeshStandardMaterial({
      color: colorForAlpha(alphaOf(surfId)),
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...position);
    m.rotation.set(...rotation);
    roomGroup.add(m);
  };

  mkPlane(w, d, [w/2, 0.001, d/2], [-Math.PI/2, 0, 0], surfaces.floor, 0.55);
  mkPlane(w, d, [w/2, h - 0.001, d/2], [Math.PI/2, 0, 0], surfaces.ceiling, 0.22);
  mkPlane(w, h, [w/2, h/2, 0], [0, Math.PI, 0], surfaces.wall_north, 0.22);
  mkPlane(w, h, [w/2, h/2, d], [0, 0, 0], surfaces.wall_south, 0.22);
  mkPlane(d, h, [w, h/2, d/2], [0, -Math.PI/2, 0], surfaces.wall_east, 0.22);
  mkPlane(d, h, [0, h/2, d/2], [0, Math.PI/2, 0], surfaces.wall_west, 0.22);

  const box = new THREE.BoxGeometry(w, h, d);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(box),
    new THREE.LineBasicMaterial({ color: 0xa0a8b4 })
  );
  edges.position.set(w/2, h/2, d/2);
  roomGroup.add(edges);
  box.dispose();

  if (isFirst && controls) {
    const d3 = Math.max(w, h, d);
    camera.position.set(w / 2 + d3 * 0.9, h + d3 * 0.5, d + d3 * 0.4);
    controls.target.set(w / 2, h * 0.4, d / 2);
    controls.update();
  }
}

function rebuildSources() {
  if (!sourcesGroup) {
    sourcesGroup = new THREE.Group();
    scene.add(sourcesGroup);
  } else {
    disposeGroup(sourcesGroup);
  }

  for (const src of state.sources) {
    const coneGeo = new THREE.ConeGeometry(0.22, 0.6, 20);
    const coneMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x333333 });
    const cone = new THREE.Mesh(coneGeo, coneMat);

    // state.position.x=width, .y=depth, .z=height → world (x, z, y)
    cone.position.set(src.position.x, src.position.z, src.position.y);

    const yaw = src.aim.yaw * Math.PI / 180;
    const pitch = src.aim.pitch * Math.PI / 180;
    const aim = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch)
    );
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), aim);
    sourcesGroup.add(cone);

    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0x000000 })
    );
    ball.position.copy(cone.position);
    sourcesGroup.add(ball);
  }
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

  const splResult = computeSPLGrid({
    sources: state.sources,
    getSpeakerDef: url => getCachedLoudspeaker(url),
    room: state.room, gridSize: 40, freq_hz: 1000, earHeight_m: 1.2,
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
      const [r, g, b] = splColorRGB(grid[j][i]);
      const idx = (j * cellsX + i) * 4;
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
    side: THREE.DoubleSide, depthWrite: false,
  });
  heatmapMesh = new THREE.Mesh(geo, mat);
  heatmapMesh.rotation.x = -Math.PI / 2;
  heatmapMesh.position.set(w/2, 1.2, d/2);
  scene.add(heatmapMesh);
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
