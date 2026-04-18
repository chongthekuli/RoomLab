import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { state, earHeightFor, getSelectedListener, colorForZone, colorForGroup } from '../app-state.js';
import { on } from '../ui/events.js';
import { getCachedLoudspeaker } from '../physics/loudspeaker.js';
import { computeSPLGrid, computeZoneSPLGrid } from '../physics/spl-calculator.js';
import { roomPlanVertices, domeGeometry, isInsideRoom3D } from '../physics/room-shape.js';

let scene, camera, renderer, controls;
let roomGroup, sourcesGroup, listenersGroup, zonesGroup, heatmapMesh;
let materialsRef, container;

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

  const bandIdx = materialsRef.frequency_bands_hz.indexOf(500);
  const useIdx = bandIdx >= 0 ? bandIdx : 2;
  const alphaOf = id => materialsRef.byId[id]?.absorption[useIdx] ?? 0;
  const wallsMatId = surfaces.walls ?? surfaces.wall_north ?? 'gypsum-board';

  const floorMat = new THREE.MeshStandardMaterial({
    color: colorForAlpha(alphaOf(surfaces.floor)),
    transparent: true, opacity: 0.55, side: THREE.DoubleSide,
  });
  const ceilMat = new THREE.MeshStandardMaterial({
    color: colorForAlpha(alphaOf(surfaces.ceiling)),
    transparent: true, opacity: 0.22, side: THREE.DoubleSide,
  });
  const wallsMat = new THREE.MeshStandardMaterial({
    color: colorForAlpha(alphaOf(wallsMatId)),
    transparent: true, opacity: 0.22, side: THREE.DoubleSide,
  });

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
      const mat = new THREE.MeshStandardMaterial({
        color: colorForAlpha(alphaOf(surfId)),
        transparent: true, opacity: 0.22, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(...pos);
      m.rotation.set(...rot);
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
      // Cylindrical wall, open-ended
      const r = room.round_radius_m ?? 3;
      const cylGeo = new THREE.CylinderGeometry(r, r, h, 48, 1, true);
      const cyl = new THREE.Mesh(cylGeo, wallsMat);
      cyl.position.set(cx, h/2, cz);
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
      const bandIdx2 = materialsRef.frequency_bands_hz.indexOf(500);
      const useIdx2 = bandIdx2 >= 0 ? bandIdx2 : 2;
      const alphaOf2 = id => materialsRef.byId[id]?.absorption[useIdx2] ?? 0;
      const n = verts.length;
      for (let i = 0; i < n; i++) {
        const v1 = verts[i];
        const v2 = verts[(i + 1) % n];
        const ex = v2.x - v1.x, ey = v2.y - v1.y;
        const edgeLen = Math.sqrt(ex * ex + ey * ey);
        if (edgeLen < 0.01) continue;
        const midX = (v1.x + v2.x) / 2;
        const midZ = (v1.y + v2.y) / 2;
        const geo = new THREE.PlaneGeometry(edgeLen, h);
        const edgeMat = new THREE.MeshStandardMaterial({
          color: colorForAlpha(alphaOf2(edges[i] ?? 'gypsum-board')),
          transparent: true, opacity: 0.22, side: THREE.DoubleSide,
        });
        const m = new THREE.Mesh(geo, edgeMat);
        m.position.set(midX, h/2, midZ);
        m.lookAt(cx, h/2, cz);
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
      // Polygon walls: N plane segments around the ring
      const n = room.polygon_sides ?? 6;
      const verts = roomPlanVertices(room);
      for (let i = 0; i < n; i++) {
        const v1 = verts[i];
        const v2 = verts[(i + 1) % n];
        const ex = v2.x - v1.x, ey = v2.y - v1.y;
        const edgeLen = Math.sqrt(ex * ex + ey * ey);
        const midX = (v1.x + v2.x) / 2;
        const midZ = (v1.y + v2.y) / 2;
        const geo = new THREE.PlaneGeometry(edgeLen, h);
        const m = new THREE.Mesh(geo, wallsMat);
        m.position.set(midX, h/2, midZ);
        m.lookAt(cx, h/2, cz);
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
    roomGroup.add(cap);
  }

  if (isFirst && controls) {
    const d3 = Math.max(w, h, d);
    camera.position.set(cx + d3 * 0.9, h + d3 * 0.5, d + d3 * 0.4);
    controls.target.set(cx, h * 0.4, cz);
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
    const outside = !isInsideRoom3D(src.position, state.room);
    const groupHex = src.groupId ? colorForGroup(src.groupId) : null;
    const groupInt = groupHex ? parseInt(groupHex.slice(1), 16) : null;
    const coneGeo = new THREE.ConeGeometry(0.22, 0.6, 20);
    const coneColor = outside ? 0xff5a3c : (groupInt ?? 0xffffff);
    const coneMat = new THREE.MeshStandardMaterial({
      color: coneColor,
      emissive: outside ? 0x550000 : (groupInt ? (groupInt & 0x666666) : 0x333333),
    });
    const cone = new THREE.Mesh(coneGeo, coneMat);
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
      new THREE.MeshStandardMaterial({ color: groupInt ?? 0x000000 })
    );
    ball.position.copy(cone.position);
    sourcesGroup.add(ball);

    // Group indicator ring below the speaker
    if (groupInt && !outside) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.35, 0.04, 8, 32),
        new THREE.MeshBasicMaterial({ color: groupInt })
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
  state.results.zoneGrids = [];
  if (!state.zones || state.zones.length === 0) return;

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

    // SPL heatmap (if sources present)
    let heatmapTex = null;
    let splInfo = null;
    if (state.sources.length > 0) {
      splInfo = computeZoneSPLGrid({
        zone, sources: state.sources,
        getSpeakerDef: url => getCachedLoudspeaker(url),
        room: state.room, gridSize: 24, freq_hz: 1000, earAbove_m: 1.2,
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

      const mat = new THREE.MeshBasicMaterial({
        map: heatmapTex, transparent: true, opacity: 0.85,
        side: THREE.DoubleSide, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(cx, zone.elevation_m + 0.01, cz);
      zonesGroup.add(mesh);
    } else {
      const mat = new THREE.MeshStandardMaterial({
        color: colorInt, transparent: true, opacity: 0.4, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(cx, zone.elevation_m + 0.01, cz);
      zonesGroup.add(mesh);
    }

    // Outline edges
    const outline = zone.vertices.map(v => new THREE.Vector3(v.x, zone.elevation_m + 0.02, v.y));
    outline.push(outline[0]);
    zonesGroup.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(outline),
      new THREE.LineBasicMaterial({ color: colorInt, linewidth: 2 })
    ));
  }

  rebuildStadiumFurniture();
}

// Builds vertical riser walls between consecutive tiers in a bowl sector, plus courtside
// risers at the front row. Makes the stair profile visible from any viewing angle.
// Also adds an overhead catwalk torus when the room is large (arena-scale).
function rebuildStadiumFurniture() {
  const zoneById = new Map(state.zones.map(z => [z.id, z]));
  const cx = state.room.width_m / 2;
  const cy = state.room.depth_m / 2;
  const arcSteps = 4; // must match what ringSectorVerts used for tier generation (5 points per arc)

  const riserMat = new THREE.MeshStandardMaterial({
    color: 0x5a4a38, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
  });

  for (const zone of state.zones) {
    const m = zone.id.match(/^(Z_lb|Z_ub)(\d+)_(\d+)$/);
    if (!m) continue;
    const [, prefix, sectorId, tierStr] = m;
    const tierNum = parseInt(tierStr, 10);
    const nextZone = zoneById.get(`${prefix}${sectorId}_${tierNum + 1}`);

    // Outer arc of this zone: first 5 vertices (arcSteps+1 points)
    const vOuter0 = zone.vertices[0];
    const vOuterEnd = zone.vertices[arcSteps];
    const r_outer = Math.hypot(vOuter0.x - cx, vOuter0.y - cy);
    const ts = Math.atan2(vOuter0.y - cy, vOuter0.x - cx);
    const te = Math.atan2(vOuterEnd.y - cy, vOuterEnd.x - cx);
    let thetaLen = te - ts;
    if (thetaLen < -0.01) thetaLen += 2 * Math.PI;

    // Between-tier riser at outer edge going up to next tier's elevation
    if (nextZone) {
      const h_bottom = zone.elevation_m;
      const h_top = nextZone.elevation_m;
      const h_diff = h_top - h_bottom;
      if (h_diff > 0.02) {
        const geo = new THREE.CylinderGeometry(r_outer, r_outer, h_diff, arcSteps * 2, 1, true, ts, thetaLen);
        const mesh = new THREE.Mesh(geo, riserMat);
        mesh.position.set(cx, h_bottom + h_diff / 2, cy);
        zonesGroup.add(mesh);
      }
    }

    // Courtside riser for tier 1 of lower bowl: step up from court floor (z=0) to tier 1
    if (prefix === 'Z_lb' && tierNum === 1 && zone.elevation_m > 0.05) {
      // Inner arc: vertices arcSteps+1..2*arcSteps+1 (in reverse direction)
      const vInnerFromEnd = zone.vertices[arcSteps + 1]; // inner at theta_end
      const vInnerToStart = zone.vertices[2 * arcSteps + 1]; // inner at theta_start
      const r_inner = Math.hypot(vInnerToStart.x - cx, vInnerToStart.y - cy);
      const ts_i = Math.atan2(vInnerToStart.y - cy, vInnerToStart.x - cx);
      const te_i = Math.atan2(vInnerFromEnd.y - cy, vInnerFromEnd.x - cx);
      let thetaLenI = te_i - ts_i;
      if (thetaLenI < -0.01) thetaLenI += 2 * Math.PI;
      const geo = new THREE.CylinderGeometry(r_inner, r_inner, zone.elevation_m, arcSteps * 2, 1, true, ts_i, thetaLenI);
      const mesh = new THREE.Mesh(geo, riserMat);
      mesh.position.set(cx, zone.elevation_m / 2, cy);
      zonesGroup.add(mesh);
    }
  }

  // Overhead catwalk torus: visual reference to arena rigging trusses. Only for large domed venues.
  if ((state.room.shape === 'polygon' || state.room.shape === 'round')
      && state.room.ceiling_type === 'dome'
      && state.room.height_m >= 10) {
    const catwalkRadius = Math.min(cx, cy) * 0.35;
    const catwalkHeight = state.room.height_m + 1;
    const ctGeo = new THREE.TorusGeometry(catwalkRadius, 0.25, 8, 48);
    const ctMat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.7, roughness: 0.35 });
    const catwalk = new THREE.Mesh(ctGeo, ctMat);
    catwalk.rotation.x = Math.PI / 2;
    catwalk.position.set(cx, catwalkHeight, cy);
    zonesGroup.add(catwalk);
    // Cables hanging from dome to truss (4 evenly-spaced thin lines)
    const cableMat = new THREE.LineBasicMaterial({ color: 0x666666 });
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const x1 = cx + catwalkRadius * Math.cos(ang);
      const z1 = cy + catwalkRadius * Math.sin(ang);
      const pts = [
        new THREE.Vector3(x1, catwalkHeight, z1),
        new THREE.Vector3(x1 * 0.7 + cx * 0.3, catwalkHeight + 3, z1 * 0.7 + cy * 0.3),
      ];
      zonesGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), cableMat));
    }
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

  const ear = earHeightFor(getSelectedListener());
  const splResult = computeSPLGrid({
    sources: state.sources,
    getSpeakerDef: url => getCachedLoudspeaker(url),
    room: state.room, gridSize: 40, freq_hz: 1000, earHeight_m: ear,
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
