import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { state, earHeightFor, getSelectedListener, colorForZone, colorForGroup, expandSources, eqGainAt } from '../app-state.js';
import { on, emit } from '../ui/events.js';
import { recordRayPaths, buildLineSegmentIndex } from '../physics/ray-viz.js';
import { getCachedLoudspeaker } from '../physics/loudspeaker.js';
import { buildRackGroup } from './rack-render.js';
import { computeSPLGrid, computeZoneSPLGrid, computeMultiSourceSPL, computeRoomConstant, precomputeSPLContext, computeMultiSourceSPLFromContext } from '../physics/spl-calculator.js';
import { computeSTIPA, precomputeSTIPAContext, computeSTIPAAt } from '../physics/stipa.js';
import { roomPlanVertices, roomEffectiveBounds, domeGeometry, isInsideRoom3D, normalizeWallSlot } from '../physics/room-shape.js';
import { getMaterialTexture, getMaterialPalette } from './textures.js';
import { ThirdPersonController } from './third-person-controller.js';
import { openPanel } from '../ui/rail-system.js';
import { loadCharacterRig } from './character-loader.js';
import { setAuditionListenerOrientation, setAuditionListenerPose, setAuditionWalkMode } from '../audio/audition.js';
import { showWalkTouchHUD, hideWalkTouchHUD } from '../ui/walk-touch-hud.js';
import { splColorRGB, stiColorRGB } from './colour-ramps.js';
import { computeTicks, formatTickLabel } from './legend-ticks.js';
import {
  makeTreatmentEntry, projectOntoNearestWall, projectOntoWall,
  wallYawDeg, rescueOrphanedTreatments,
} from '../ui/panel-treatments.js';
import { findCatalogueEntry, loadSurfaceCatalogue } from '../labs/surfacelab/catalog.js';
import { buildSampleGroup } from '../labs/surfacelab/surface-3d-preview.js';

let scene, camera, renderer, controls;
let composer, ssaoPass, bloomPass;
let roomGroup, sourcesGroup, listenersGroup, zonesGroup, heatmapGroup, heatmapMesh;
let aimLinesGroup, audienceGroup;
let racksGroup = null;
// Acoustic-treatment panels — rebuilt on treatment:changed. Each child is
// a Group tagged userData.tag='treatment' carrying:
//   userData.treatmentId   — state.treatments[i].id (selection / drag pick)
//   userData.surface       — 'wall' | 'ceiling' (drag-plane constraint)
//   userData.wallIndex?    — polygon edge index when surface === 'wall'
// v1 = visual-only; not part of any physics group.
let treatmentsGroup = null;
let _floorGrid = null;       // GridHelper backdrop; hidden during print capture
let _ambientLight = null;    // Module-scope refs so captureViewportImage can
let _hemiLight = null;       // mildly lift exposure during print, restore after.
let _keyLight = null;        // Shadow-casting directional. Capture expands its
                             // shadow camera to envelop arena-scale rooms so
                             // the floor / far wall don't render fully-shadowed.
let _rackCatalogue = null;
let _ampCatalog = null;
let rayGroup = null;
let _rayPathsCache = null;       // last recorded { pathData, pathOffsets, colorData, stats }
let _rayBuildToken = 0;          // increments on every (re)build to detect stale work
const audienceGeoCache = {}; // { standing: {body, head, ref}, sitting: {...} }
let materialsRef, container;

// --- Walkthrough (3rd-person) mode ---------------------------------------
// A suited-man avatar the user can drive around the actual simulated scene
// with W/A/S/D + Q/E keys, seeing the venue from human scale. Shares the
// same Three.js scene as 3D View — only the camera swaps when the user
// switches tabs, so speakers / heatmaps / bowl structure are all visible
// from inside the room.
// --- 3D probe tool (hover for XYZ + SPL) ---------------------------------
// A single reusable sphere marker + HTML tooltip that follow the mouse
// cursor. Raycasts against roomGroup each move; computes multi-source SPL
// at the hit point using the current physics options.
let probeMarker = null;
let probeTooltip = null;
let probeRaycaster = null;
const _probeMouse = { x: 0, y: 0 };
let probeActive = false;

// ThirdPersonController owns: movement, orbit/chase camera, WASD, mouse
// drag, wheel zoom, raycast collision. Scene.js still builds the avatar
// (procedural Group) and drives the 6 procedural animation layers via
// the controller's onAnimate hook.
let walkCamera, avatar, walkHint, walkSplOverlay;
let _stipaLast = null, _stipaLastTs = 0;   // cached STIPA result (4 Hz refresh)
let avatarParts = null;       // { armL, armR, legL, legR, body }
let activeCamera = null;
let walkMode = false;
let walkPhase = 0;            // stride phase for leg/arm swing animation
let _lastAuditionOrientTs = 0;  // ms — last time we pushed walk yaw/pitch to AudioListener
let tpController = null;
let tpLastTs = 0;
// Rigged GLTF character (loaded async). When present, the avatar swaps to
// this rig and procedural animation layers are bypassed in favor of the
// AnimationMixer's idle/walk/run crossfade.
let riggedAvatar = null;
// 6-layer procedural animation state — driven by controller onAnimate().
const animState = {
  jumpPhase: 'grounded',      // 'anticipate' | 'airborne' | 'landing' | 'grounded'
  jumpT: 0,
  impactVel: 0,
  landingAmount: 0,
  prevYaw: 0,
  yawRate: 0,
  turnLean: 0,
  runFactor: 0,
  crouchF: 0,
  // Sit posture — edge-toggled on Z. sitF is a smoothly lerped 0→1 scalar
  // that drives the pose; sitting is the discrete bool target. sitLatch
  // prevents rapid toggle while Z is held.
  sitting: false,
  sitF: 0,
  sitLatch: false,
};
const AVATAR_EYE_HEIGHT = 1.68;
const CROUCH_FACTOR = 0.28;       // crouched body is 1 − 0.28 = 72 % of standing
const JUMP_VELOCITY_MS = 4.0;     // initial upward velocity when jumping

// Flip all heatmap visibility in one place. Structural geometry (bowls, walls,
// floor, outlines) stays visible. Kept as a named export so the UI toolbar
// button and any future API can toggle from outside.
export function toggleHeatmaps(force) {
  const next = typeof force === 'boolean' ? force : !state.display.showHeatmaps;
  state.display.showHeatmaps = next;
  if (heatmapGroup) heatmapGroup.visible = next;
  if (heatmapMesh) heatmapMesh.visible = next;
}

// Aim-line indicator toggle — draws a thin coloured line from every speaker
// element along its aim direction, extending ~8 m so the user can see where
// each box is actually pointing. Off by default (adds visual noise when on).
export function toggleAimLines(force) {
  const next = typeof force === 'boolean' ? force : !state.display.showAimLines;
  state.display.showAimLines = next;
  if (aimLinesGroup) aimLinesGroup.visible = next;
}

// Heatmap-metric toggle — cycles the 3D heatmap between SPL (dB coverage)
// and STIPA (IEC 60268-16 speech-intelligibility index, 0–1). The vertex
// color palette and right-side legend both swap. Rebuilds zones so the
// surface meshes re-sample with the new metric.
export function toggleHeatmapMode(force) {
  const curr = state.display.heatmapMode ?? 'spl';
  const next = typeof force === 'string' ? force : (curr === 'spl' ? 'stipa' : 'spl');
  state.display.heatmapMode = next;
  rebuildZones();
  rebuildHeatmap();
}

// Isobar toggle — show/hide the marching-squares contour lines. Triggers a
// heatmap rebuild since the contour LineSegments are rebuilt each time.
export function toggleIsobars(force) {
  const next = typeof force === 'boolean' ? force : !state.display.showIsobars;
  state.display.showIsobars = next;
  // Rebuild zones so contours are freshly extracted (or removed).
  rebuildZones();
}

// Reverberant-field toggle. Because the Hopkins-Stryker diffuse model is
// spatially UNIFORM, turning it on lifts every listener position by the
// same amount — useful for "total SPL" readouts but it masks coverage
// differences between speaker groups on the heatmap. Default off so the
// main visual answers "where does each speaker hit" instead of "what's
// the statistical total".
export function toggleReverbField(force) {
  const next = typeof force === 'boolean' ? force : !state.physics.reverberantField;
  state.physics.reverberantField = next;
  // Re-sample every heatmap surface with the new option.
  rebuildZones();
  rebuildHeatmap();
}

// Probe tool toggle — enables hover SPL readout over the 3D viewport.
export function toggleProbe(force) {
  const next = typeof force === 'boolean' ? force : !probeActive;
  probeActive = next;
  if (probeMarker) probeMarker.visible = false;
  if (probeTooltip) probeTooltip.classList.toggle('hidden', !next);
  if (container) container.style.cursor = next ? 'crosshair' : '';
}

// PA equipment racks — caller (main.js) hands us the catalogues at boot
// so rebuildRacks doesn't need to fetch on every rebuild.
export function setRackCatalogues({ rackCatalogue, ampCatalog }) {
  _rackCatalogue = rackCatalogue;
  _ampCatalog = ampCatalog;
}

// Ray-viz toggle. Off by default — when the user clicks ON for the
// first time after a state change, we run the small viz tracer
// (~200 paths total, single-threaded, <500 ms even on pavilion-class
// scenes) and build a single LineSegments mesh. Subsequent on/off
// toggles are instant. Any state mutation (preset swap, source move,
// room edit) clears the cache and disables the toggle until the next
// successful build.
//
// Per Martina's review: paths live in scene-only ephemeral state,
// NEVER in state.results.* — Float32Array would corrupt save/load.
export function toggleRayViz(force) {
  const next = typeof force === 'boolean' ? force : !state.display.showRays;
  state.display.showRays = next;
  if (!next) {
    // Hide instantly. Cache + group stay alive so re-enabling is fast.
    if (rayGroup) rayGroup.visible = false;
    return;
  }
  // Turning ON. If we have cached paths, just unhide. Otherwise run
  // the tracer. The build is synchronous and fast enough that a
  // spinner is overkill; a slight UI hitch on pavilion is acceptable
  // for a debug feature.
  if (_rayPathsCache && rayGroup && rayGroup.children.length > 0) {
    rayGroup.visible = true;
    return;
  }
  rebuildRayViz();
}

function rebuildRayViz() {
  if (!materialsRef) return; // viewport not mounted yet
  if (!rayGroup) {
    rayGroup = new THREE.Group();
    rayGroup.name = 'ray-viz';
    rayGroup.matrixAutoUpdate = false;
    if (typeof scene !== 'undefined' && scene) scene.add(rayGroup);
  } else {
    disposeGroup(rayGroup);
  }
  // Stamp this build so a future invalidation event mid-trace doesn't
  // attach stale geometry. (Tracer is synchronous in v1, so this is
  // mostly future-proofing — but cheap.)
  const myToken = ++_rayBuildToken;

  let result;
  try {
    result = recordRayPaths({
      state, materials: materialsRef,
      getLoudspeakerDef: getCachedLoudspeaker,
      totalPaths: 200,
      maxBounces: 24,
    });
  } catch (err) {
    console.error('[ray-viz] tracer failed:', err);
    return;
  }
  if (myToken !== _rayBuildToken) return; // superseded by another build

  _rayPathsCache = result;

  if (!result || result.stats.totalPaths === 0) {
    rayGroup.visible = !!state.display.showRays;
    return;
  }

  // Build a single LineSegments mesh with vertex colors. One geometry,
  // one material, one draw call — Viktor's recommendation. Two-floats-
  // per-vertex offsets indexed via Uint32 keeps headroom for future N
  // increases without touching this code path.
  //
  // Coord-system swap: ray-viz returns pathData in PHYSICS / state
  // coords (x=width, y=depth, z=up). Three.js is y=up, z=depth. Every
  // other render path in scene.js does this swap explicitly (e.g.
  // `encl.position.set(src.position.x, src.position.z, src.position.y)`
  // when placing speaker enclosures). We do it once here while copying
  // into the BufferGeometry so ray-viz.js can stay coord-pure for tests
  // and any future physics consumer.
  const N = result.pathData.length;
  const renderPos = new Float32Array(N);
  for (let i = 0; i < N; i += 3) {
    renderPos[i + 0] = result.pathData[i + 0]; // x stays x
    renderPos[i + 1] = result.pathData[i + 2]; // state z (up)    → three y (up)
    renderPos[i + 2] = result.pathData[i + 1]; // state y (depth) → three z (depth)
  }
  const indices = buildLineSegmentIndex(result.pathOffsets);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(renderPos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(result.colorData, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));

  const mat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.85,
    depthWrite: false, depthTest: true,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.matrixAutoUpdate = false;
  lines.userData.tag = 'ray-viz-lines';
  rayGroup.add(lines);
  rayGroup.visible = !!state.display.showRays;
}

// Invalidate cached paths when the scene changes. Subscribed below in
// init alongside the other rebuild handlers. Disposes the group, nulls
// the cache, and auto-disables the toggle so the user clicks-to-rebuild
// rather than seeing stale rays through new geometry (Martina, CRITICAL).
function invalidateRayViz() {
  _rayBuildToken++; // poison any in-flight build
  _rayPathsCache = null;
  if (rayGroup) {
    disposeGroup(rayGroup);
    rayGroup.visible = false;
  }
  // Auto-flip the toggle off — the user explicitly opts in again on
  // the next click, which retraces against the new scene.
  if (state.display.showRays) {
    state.display.showRays = false;
    // Sync the toolbar button's active class via a synthetic emit; the
    // wiring in main.js already handles this for other toggles.
    document.getElementById('toggle-rays')?.classList.remove('active');
  }
}

export async function mount3DViewport({ materials }) {
  materialsRef = materials;
  container = document.getElementById('view-3d');
  if (!container) return;

  initScene();

  // RAF-coalesced rebuild dispatcher — Martina audit #4. When the user drags
  // a zone-occupancy slider, the `input` event fires on every pixel change
  // and the naive `on('room:changed', …)` handler used to run rebuildRoom
  // + rebuildZones + rebuildHeatmap synchronously on each tick. For the
  // 48-zone arena preset that's 2.4 M SPL samples per drag step → UI stall.
  // Collapsing to one rebuild per animation frame keeps the slider feel
  // live AND avoids the freeze.
  let _pendingRebuild = null;   // bitfield of pending rebuild tasks
  let _rebuildRAF = 0;
  const REBUILD_ROOM = 1 << 0;
  const REBUILD_SOURCES = 1 << 1;
  const REBUILD_LISTENERS = 1 << 2;
  const REBUILD_ZONES = 1 << 3;
  const REBUILD_HEATMAP = 1 << 4;
  const REBUILD_AIM = 1 << 5;
  const REBUILD_ROOM_FULL = 1 << 6;
  const REBUILD_RACKS = 1 << 7;
  const REBUILD_TREATMENTS = 1 << 8;
  const queueRebuild = (flags) => {
    _pendingRebuild = (_pendingRebuild ?? 0) | flags;
    if (_rebuildRAF) return;
    _rebuildRAF = requestAnimationFrame(() => {
      const f = _pendingRebuild ?? 0;
      _pendingRebuild = null;
      _rebuildRAF = 0;
      if (f & REBUILD_ROOM_FULL) rebuildRoom(true);
      else if (f & REBUILD_ROOM) rebuildRoom(false);
      if (f & REBUILD_SOURCES) rebuildSources();
      if (f & REBUILD_LISTENERS) rebuildListeners();
      if (f & REBUILD_ZONES) rebuildZones();
      if (f & REBUILD_HEATMAP) rebuildHeatmap();
      if (f & REBUILD_AIM) rebuildAimLines();
      if (f & REBUILD_RACKS) rebuildRacks();
      if (f & REBUILD_TREATMENTS) rebuildTreatments();
    });
  };

  // Register event subscriptions BEFORE the first paint — Martina audit #8.
  // If they sit after the rebuilds, a preset-click that lands between
  // boot's Promise.all(loadLoudspeaker…) and mount3DViewport completing
  // emits scene:reset into the void and the 3D view shows stale geometry.
  on('room:changed', () => {
    invalidateRayViz();
    // Treatments anchored to walls must follow when vertices move. We
    // rescue orphans (wallIndex now out of range) by re-projecting onto
    // the nearest surviving wall, and re-project surviving anchors onto
    // their (possibly moved) wall segment so they stay on the wall plane.
    reanchorTreatmentsOnRoomChange();
    queueRebuild(REBUILD_ROOM | REBUILD_ZONES | REBUILD_HEATMAP | REBUILD_AIM | REBUILD_TREATMENTS);
  });
  on('source:changed', () => { invalidateRayViz(); queueRebuild(REBUILD_SOURCES | REBUILD_ZONES | REBUILD_HEATMAP); });
  on('source:model_changed', () => { invalidateRayViz(); queueRebuild(REBUILD_SOURCES | REBUILD_ZONES | REBUILD_HEATMAP); });
  on('treatment:changed', () => queueRebuild(REBUILD_TREATMENTS));
  on('treatment:selected', () => queueRebuild(REBUILD_TREATMENTS));
  // Treatments panel asks the 3D viewport to arm placement mode — the
  // next click on a wall or the ceiling will drop a new entry of the
  // chosen productId at the hit point.
  on('treatment:arm_placement', ({ productId } = {}) => {
    armTreatmentPlacement(productId).catch(err =>
      console.warn('[scene] arm placement failed:', err));
  });
  on('treatment:cancel_placement', () => {
    cancelTreatmentPlacement();
    try { emit('treatment:placement_cancelled'); } catch (_) {}
  });
  on('listener:changed', () => queueRebuild(REBUILD_LISTENERS | REBUILD_HEATMAP));
  on('listener:selected', () => {
    queueRebuild(REBUILD_LISTENERS | REBUILD_HEATMAP);
    focusCameraOnSelectedListener();
  });
  on('scene:reset', () => {
    invalidateRayViz();
    // NUCLEAR DISPOSAL — kill every group's contents IMMEDIATELY before
    // the RAF-coalesced rebuild fires. Without this, between the
    // emit('scene:reset') call and the next animation frame the user
    // can see leftover audience figures, speakers, or bowl geometry
    // for one or more frames. The user reported this exact failure
    // mode multiple times: arena→pavilion crossover, pavilion-zones
    // bleed into hi-fi, custom-room-shows-arena-audience.
    //
    // Belt-and-braces: the rebuild functions also dispose at their
    // start, but those run async on RAF. Disposing here closes the
    // race window completely.
    if (roomGroup)        disposeGroup(roomGroup);
    if (sourcesGroup)     disposeGroup(sourcesGroup);
    if (listenersGroup)   disposeGroup(listenersGroup);
    if (zonesGroup)       disposeGroup(zonesGroup);
    if (heatmapGroup)     disposeGroup(heatmapGroup);
    if (audienceGroup)    disposeGroup(audienceGroup);
    if (aimLinesGroup)    disposeGroup(aimLinesGroup);
    if (racksGroup)       disposeGroup(racksGroup);
    if (treatmentsGroup)  disposeGroup(treatmentsGroup);
    // Drop any placement ghost left over from a cancelled-but-not-cleared
    // session — preset/template/load wipes the scene; the ghost cannot
    // outlive its parent room.
    clearPlacementGhost();
    cancelTreatmentPlacement();

    // Auto-fit camera to the new room. Without this, a swap from a 60 m
    // arena to a 4.5 m hi-fi leaves the camera 80 m back and the user
    // has to scroll-zoom every preset apply. queueRebuild is async (RAF-
    // coalesced) but frameCameraToRoom only reads state.room dims, so
    // calling synchronously here is correct — the camera lands the same
    // frame the rebuild renders.
    frameCameraToRoom();
    queueRebuild(REBUILD_ROOM | REBUILD_SOURCES | REBUILD_LISTENERS | REBUILD_ZONES | REBUILD_HEATMAP | REBUILD_RACKS | REBUILD_TREATMENTS);
  });
  // Rack-builder edits — user added/removed an amp or moved a rack.
  on('rack:changed', () => queueRebuild(REBUILD_RACKS));
  // Master EQ change: heatmap + aim lines depend on per-band SPL; refresh
  // both. Zone/listener panels don't need re-render (state.zones is
  // unchanged) so we skip them.
  on('physics:eq_changed', () => queueRebuild(REBUILD_HEATMAP | REBUILD_AIM));
  // Ambient noise affects STIPA heatmap values (N in the STI denominator).
  // SPL heatmap is unchanged — the per-vertex loop reads `useSTI` and only
  // the STIPA branch reads ambient, so rebuilding when SPL is active is a
  // no-op cost. Accept that for simplicity.
  on('ambient:changed', () => queueRebuild(REBUILD_HEATMAP));

  // Initial paint: fire the rebuilds synchronously (no user-drag coalescing
  // needed on boot; they run once and we want the viewport ready).
  rebuildRoom(true);
  rebuildSources();
  rebuildListeners();
  rebuildZones();
  rebuildHeatmap();
  rebuildTreatments();
  animate();

  window.addEventListener('resize', onResize);
  document.addEventListener('viewport:tab-changed', e => {
    if (e.detail.view === '3d') requestAnimationFrame(onResize);
  });
  // Side-panel open / close (and any other layout change) shifts the
  // container's clientWidth without firing window resize. Without a
  // matching renderer.setSize the canvas drawing buffer stays at the
  // old size and gets stretched onto the new visual rect — cursor →
  // NDC math drifts off the visible speaker by the stretch ratio,
  // producing the "hover highlights the wrong speaker" symptom.
  //
  // ResizeObserver fires whenever the container's content rect
  // changes for ANY reason, so the renderer + camera aspect always
  // match what's actually on screen.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => requestAnimationFrame(onResize));
    ro.observe(container);
  }
}

function initScene() {
  scene = new THREE.Scene();
  // Deep slate background with a subtle vertical gradient look (dark at top
  // fading to near-black at the horizon) via a shader-free approach: solid
  // base color, tone-mapping handles perceptual brightness in the final pass.
  scene.background = new THREE.Color(0x12151b);
  // Depth fog so the far end of the arena doesn't pop — fades geometry into
  // the background at 50-110 m. Matches scene size; keeps the horizon soft.
  scene.fog = new THREE.Fog(0x12151b, 55, 110);

  const w = Math.max(container.clientWidth, 1);
  const h = Math.max(container.clientHeight, 1);

  // 38° FOV is the architectural-photography convention — reduces distortion
  // on the bowl curve and gives a more "cinematic" compression than 45°.
  camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 300);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // Modern archviz defaults: ACES filmic tone mapping gives cinematic contrast
  // response (deepens shadows, softens highlights). sRGB output-color-space
  // matches what every monitor expects. Exposure 1.0 is neutral; +/−0.15
  // would skew bright/dark. These two lines are the biggest cheap polish win.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Soft shadow maps — enabled but only sparingly cast (see dir-light setup
  // below). PCFSoftShadowMap is the middle ground between perf and quality.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Remove the static-HTML "Loading 3D view…" placeholder, but PRESERVE
  // any other static markup inside #view-3d (e.g. #walk-touch-controls
  // — the joystick / action-button HUD). Earlier this was a wholesale
  // `container.innerHTML = ''` which detached the HUD from the live DOM
  // and made walk-mode show() silently no-op against an orphaned node.
  container.querySelector('.viewport-loading')?.remove();
  container.style.position = 'relative';
  container.appendChild(renderer.domElement);
  // Post-processing (SSAO/Bloom/SMAA) is temporarily disabled — the previous
  // composer chain was bleaching the entire scene through a color-pipeline
  // interaction with SSAOPass. Back to direct renderer.render() which looks
  // correct. Revisit as a separate, carefully-validated pass.
  composer = null;

  // SPL/STI legend overlay (HTML over the WebGL canvas, bottom-right of
  // viewport). Three rows: title, gradient bar with tick marks, data-range
  // footer. Gradient + ticks are populated by updateSPLLegend() based on
  // state.display.heatmapMode and current min/max.
  const legend = document.createElement('div');
  legend.className = 'spl-legend-3d hidden';
  legend.id = 'spl-legend-3d';
  legend.innerHTML = `
    <div class="legend-title">SPL</div>
    <div class="legend-scale">
      <div class="legend-bar"></div>
      <div class="legend-ticks"></div>
    </div>
    <div class="legend-range">
      <span class="legend-min">—</span>
      <span class="legend-sep">–</span>
      <span class="legend-max">—</span>
    </div>
  `;
  container.appendChild(legend);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1;
  controls.maxDistance = 80;

  // --- Lighting rig — 3-light archviz setup -----------------------------
  // Hemisphere gives a subtle sky/ground tint that replaces flat ambient —
  // slightly warmer up top, cooler below, mimicking daylight bounce.
  _hemiLight = new THREE.HemisphereLight(0xbfd0e8, 0x2a2620, 0.4);
  _hemiLight.position.set(0, 30, 0);
  scene.add(_hemiLight);

  // Key: main directional light from a high front-right angle, slightly warm.
  // Only this light casts shadows (perf-friendly on arena-scale scenes).
  _keyLight = new THREE.DirectionalLight(0xfff4e0, 1.15);
  _keyLight.position.set(25, 40, 18);
  _keyLight.castShadow = true;
  _keyLight.shadow.mapSize.width = 2048;
  _keyLight.shadow.mapSize.height = 2048;
  _keyLight.shadow.camera.near = 5;
  _keyLight.shadow.camera.far = 120;
  _keyLight.shadow.camera.left   = -45;
  _keyLight.shadow.camera.right  =  45;
  _keyLight.shadow.camera.top    =  45;
  _keyLight.shadow.camera.bottom = -45;
  _keyLight.shadow.bias = -0.0005;
  _keyLight.shadow.normalBias = 0.02;
  scene.add(_keyLight);

  // Fill: cooler counter-light from opposite side, no shadows, lower intensity.
  const fill = new THREE.DirectionalLight(0xa8c0d8, 0.35);
  fill.position.set(-22, 28, -10);
  scene.add(fill);

  // Rim / ambient lift so dome + bowl back don't fall into pure black.
  _ambientLight = new THREE.AmbientLight(0xffffff, 0.22);
  scene.add(_ambientLight);

  // Procedural image-based lighting via RoomEnvironment — bakes subtle
  // environment reflections onto every MeshStandardMaterial without
  // shipping an HDR file. Kills the "matte clay" look on speakers and
  // concrete without costing runtime performance after the one-time bake.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

  // Subtle floor grid only — no more axes helper (looked like a WIP viewport).
  _floorGrid = new THREE.GridHelper(60, 30, 0x262b33, 0x1a1d22);
  _floorGrid.position.y = -0.01;
  _floorGrid.material.transparent = true;
  _floorGrid.material.opacity = 0.35;
  scene.add(_floorGrid);

  initWalkthrough();
  initProbeTool();
  activeCamera = camera;
}

// Mouse-driven SPL probe: hover the 3D canvas to read XYZ + SPL at any
// surface. Raycasts into roomGroup (structural geometry only — heatmap
// overlay is filtered out so the probe reports on the real surface).
function initProbeTool() {
  probeRaycaster = new THREE.Raycaster();

  // Small accent-colored sphere that follows the cursor on the surface.
  const markerMat = new THREE.MeshBasicMaterial({
    color: 0x4aa3ff, transparent: true, opacity: 0.95, depthTest: false,
  });
  probeMarker = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), markerMat);
  probeMarker.renderOrder = 999;
  probeMarker.visible = false;
  scene.add(probeMarker);

  // Floating tooltip — positioned in screen-space next to the cursor.
  probeTooltip = document.createElement('div');
  probeTooltip.className = 'probe-tooltip hidden';
  probeTooltip.id = 'probe-tooltip';
  container.appendChild(probeTooltip);

  renderer.domElement.addEventListener('mousemove', onProbeMouseMove);
  renderer.domElement.addEventListener('mouseleave', () => {
    if (probeMarker) probeMarker.visible = false;
    if (probeTooltip) probeTooltip.classList.add('hidden');
    setSpeakerHighlight(_hoveredSpeakerGroup, false);
    _hoveredSpeakerGroup = null;
    renderer.domElement.style.cursor = '';
  });
  // Drag-vs-click discriminator. Browsers fire `click` after a tiny
  // mouse movement (sub-3 px) which means a small orbit drag still
  // triggers downstream click handlers — landing the user on a wall-
  // material picker when they only meant to nudge the camera. We
  // capture the pointer-down position, track the distance travelled,
  // and on click suppress propagation if the user moved more than
  // a UX-meaningful threshold. Registered in CAPTURE phase so it
  // runs BEFORE onSpeakerClick / onSurfaceClick / onSubStructureClick
  // (which are in bubble phase) — `stopImmediatePropagation` then
  // halts all further click listeners for this event.
  //
  // pointermove is on WINDOW (not canvas) because OrbitControls
  // captures the pointer during a drag — pointer events get
  // redirected away from the canvas element, so a canvas-scoped
  // listener wouldn't see the movement and _ptrDragged stays false.
  // The window listener catches pointermove regardless of capture,
  // and we use `mousemove` as a belt-and-braces second source in
  // case any browser routes mouse and pointer differently.
  let _ptrDownX = 0, _ptrDownY = 0, _ptrDragged = false;
  const DRAG_CLICK_THRESHOLD_PX = 6;
  const onPtrDown = (e) => {
    _ptrDownX = e.clientX;
    _ptrDownY = e.clientY;
    _ptrDragged = false;
  };
  const onPtrMove = (e) => {
    // e.buttons is 0 when no button is held — skip in that case so
    // pure hover doesn't accidentally count as a drag.
    if (e.buttons === 0 && e.pressure === undefined) return;
    const dx = e.clientX - _ptrDownX;
    const dy = e.clientY - _ptrDownY;
    if (Math.hypot(dx, dy) > DRAG_CLICK_THRESHOLD_PX) _ptrDragged = true;
  };
  renderer.domElement.addEventListener('pointerdown', onPtrDown, true);
  renderer.domElement.addEventListener('mousedown',  onPtrDown, true);
  window.addEventListener('pointermove', onPtrMove, true);
  window.addEventListener('mousemove',   onPtrMove, true);
  renderer.domElement.addEventListener('click', (e) => {
    if (_ptrDragged) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);

  // Click-to-inspect: tapping a loudspeaker cabinet in 3D opens the
  // Speaker workbench focused on that model.
  renderer.domElement.addEventListener('click', onSpeakerClick);
  // Click-to-pulse: tapping a wall / floor / ceiling pulses the matching
  // material picker in the Room panel. Registered after onSpeakerClick so
  // a speaker hit (closer than the wall) takes priority — onSurfaceClick
  // bails internally when a speaker is the nearer hit.
  renderer.domElement.addEventListener('click', onSurfaceClick);
  // Click-to-select: tapping a placed sub-room picks it as a single unit.
  // Registered AFTER the surface click so sub-structure selection runs
  // independently — the pulse + sub-selection can both fire when the user
  // clicks a sub's wall (the wall pulse is harmless and gives extra
  // affordance). Internal speaker priority + walk/probe early-out matches
  // onSurfaceClick.
  renderer.domElement.addEventListener('click', onSubStructureClick);
  // Hover-highlight + click-to-pivot on speakers.
  renderer.domElement.addEventListener('pointermove', onSpeakerHoverMove);
  renderer.domElement.addEventListener('pointerdown', onSpeakerPointerDown);
  // Treatment drag — pointerdown on a placed treatment starts a
  // surface-constrained drag. Registered AFTER the speaker handler so
  // speakers stay clickable when one happens to overlap a panel; the
  // treatment handler hit-tests treatmentsGroup, not sourcesGroup, so
  // they don't compete.
  renderer.domElement.addEventListener('pointerdown', onTreatmentPointerDown);
}

// ---- Speaker hover-highlight + click-to-pivot -------------------------
// Hover: on mouse-over, emissive-boost the speaker's materials so the user
// knows they've caught one. Click-hold: the speaker becomes the OrbitControls
// pivot so dragging orbits AROUND the speaker instead of the room centre —
// useful when inspecting a specific element in a dense line-array or a
// ceiling-speaker grid. The short click (no drag) still opens the Speaker
// workbench via the separate onSpeakerClick handler; setting the pivot on
// pointerdown doesn't interfere because OrbitControls reads the new target
// only when a subsequent drag gesture starts.
let _hoveredSpeakerGroup = null;
const _hoverRay = new THREE.Raycaster();
const _hoverNdc = { x: 0, y: 0 };
const _speakerHighlightColor = new THREE.Color(0xffcc55);   // warm amber
const _speakerHighlightBoost = 0.55;

function findSpeakerGroup(obj) {
  // Walk up from a hit mesh to the Group that represents the whole cabinet.
  // Every speaker root gets userData.speakerModelUrl on its direct-child
  // Group (see rebuildSources → encl). Aim rings under sourcesGroup lack
  // that tag, so they're excluded naturally.
  let o = obj;
  while (o && o !== sourcesGroup) {
    if (o.userData?.speakerModelUrl && o.parent === sourcesGroup) return o;
    o = o.parent;
  }
  return null;
}

function setSpeakerHighlight(group, on) {
  if (!group) return;
  group.traverse(m => {
    if (!m.isMesh || !m.material || !m.material.emissive) return;
    const store = m.userData;
    if (on) {
      if (!store._origEmissiveHex && store._origEmissiveHex !== 0) {
        store._origEmissiveHex = m.material.emissive.getHex();
        store._origEmissiveIntensity = m.material.emissiveIntensity ?? 1;
      }
      m.material.emissive.copy(_speakerHighlightColor);
      m.material.emissiveIntensity = (store._origEmissiveIntensity ?? 1) + _speakerHighlightBoost;
      m.material.needsUpdate = true;
    } else if (store._origEmissiveHex !== undefined) {
      m.material.emissive.setHex(store._origEmissiveHex);
      m.material.emissiveIntensity = store._origEmissiveIntensity ?? 1;
      m.material.needsUpdate = true;
      delete store._origEmissiveHex;
      delete store._origEmissiveIntensity;
    }
  });
}

function onSpeakerHoverMove(e) {
  if (walkMode || !sourcesGroup) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _hoverNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _hoverNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _hoverRay.setFromCamera(_hoverNdc, activeCamera || camera);
  const hits = _hoverRay.intersectObject(sourcesGroup, true);
  const hitGroup = hits.length > 0 ? findSpeakerGroup(hits[0].object) : null;
  if (hitGroup !== _hoveredSpeakerGroup) {
    setSpeakerHighlight(_hoveredSpeakerGroup, false);
    setSpeakerHighlight(hitGroup, true);
    _hoveredSpeakerGroup = hitGroup;
    renderer.domElement.style.cursor = hitGroup ? 'grab' : '';
  }
}

const _pivotVec = new THREE.Vector3();
function onSpeakerPointerDown(e) {
  // Left-button only — middle/right drag should pan normally on room centre.
  if (e.button !== 0) return;
  if (walkMode || !_hoveredSpeakerGroup || !controls) return;
  _hoveredSpeakerGroup.getWorldPosition(_pivotVec);
  controls.target.copy(_pivotVec);
  renderer.domElement.style.cursor = 'grabbing';
  const onUp = () => {
    renderer.domElement.style.cursor = _hoveredSpeakerGroup ? 'grab' : '';
    renderer.domElement.removeEventListener('pointerup', onUp);
    renderer.domElement.removeEventListener('pointercancel', onUp);
  };
  renderer.domElement.addEventListener('pointerup', onUp);
  renderer.domElement.addEventListener('pointercancel', onUp);
}

const _speakerClickRay = new THREE.Raycaster();
const _speakerClickNdc = { x: 0, y: 0 };
function onSpeakerClick(e) {
  if (walkMode || !sourcesGroup) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _speakerClickNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _speakerClickNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _speakerClickRay.setFromCamera(_speakerClickNdc, activeCamera || camera);
  const hits = _speakerClickRay.intersectObject(sourcesGroup, true);
  for (const h of hits) {
    const url = h.object.userData?.speakerModelUrl;
    if (!url) continue;
    const srcIdx = h.object.userData?.sourceIndex;
    state.selectedSpeakerUrl = url;
    emit('speaker:selected');
    // Persistent selection — same flow as the 2D click. Sets state,
    // opens the Sources panel, paints the matching card with the
    // cyan ring, scrolls it into view, AND fires the transient flash
    // pulse so the user catches the move.
    if (typeof srcIdx === 'number') {
      try { openPanel('left', 'sources'); } catch (_) {}
      if (state.selectedSourceIdx !== srcIdx) {
        state.selectedSourceIdx = srcIdx;
        emit('source:selected', { idx: srcIdx });
      }
      emit('source:highlight', { index: srcIdx });
    }
    return;
  }
}

// ---- Surface click → side-panel pulse ---------------------------------
// Maya's spec (CUSTOM_ROOM_DESIGN.md §6): clicking a wall / floor / ceiling
// in the 3D viewport pulses the matching material picker in the Room panel
// rather than opening a popover. We raycast roomGroup, filter heatmap +
// zone overlays, read userData.surface_id, and emit `surface:picked`. The
// panel scrolls to the matching <select>, pulses an amber outline, and
// programmatically focuses the dropdown so picking a material is one click.
//
// Speaker priority: if a speaker mesh is closer to the camera than the wall,
// the speaker click handler already fired (registered earlier on the same
// element) and we bail. Probe / walk modes get explicit early-out flags.
const _surfaceClickRay = new THREE.Raycaster();
const _surfaceClickNdc = { x: 0, y: 0 };
function onSurfaceClick(e) {
  if (walkMode || probeActive) return;
  if (e.button !== 0) return;
  if (!roomGroup) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _surfaceClickNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _surfaceClickNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _surfaceClickRay.setFromCamera(_surfaceClickNdc, activeCamera || camera);

  // Treatment placement — if the panel armed a productId, the next
  // wall/ceiling click drops a new treatment there and consumes the
  // click. Done BEFORE surface selection so the user doesn't get a
  // sticky cyan wall highlight on top of the placement.
  if (_pendingPlacementProductId) {
    const roomHitsForPlace = _surfaceClickRay.intersectObject(roomGroup, true);
    if (_handlePlacementClick(roomHitsForPlace)) return;
  }

  // Closest valid room hit (skip heatmap layers, zone overlays, untagged
  // helper meshes). Hits arrive sorted near→far from intersectObject.
  //
  // Wall-segment priority: a shared wall (tag='wall_segment') is the
  // CANONICAL surface for an overlap region. From inside the parent
  // room the hut's far wall sits in front of the merged wall, but the
  // user's intent when clicking the merged region is the merged wall.
  // First pass picks any wall_segment along the ray; second pass falls
  // back to the nearest hit with a real surface_id. Every other
  // interaction (parent walls, enclosure walls, floor, ceiling) is
  // unchanged because pass 2 sees the same hit list.
  const roomHits = _surfaceClickRay.intersectObject(roomGroup, true);
  let bestRoomDist = Infinity;
  let bestSurfId = null;
  // Pass 1 — any wall_segment hit wins, regardless of distance.
  for (const h of roomHits) {
    if (h.object.userData?.tag !== 'wall_segment') continue;
    const surfId = h.object.userData?.surface_id;
    if (!surfId) continue;
    bestRoomDist = h.distance;
    bestSurfId = surfId;
    break;
  }
  // Pass 2 — nearest non-wallSegment hit, original behaviour.
  if (!bestSurfId) {
    for (const h of roomHits) {
      const tag = h.object.userData?.tag ?? '';
      if (tag.startsWith('heatmap_')) continue;
      if (h.object.userData?.zone_id) continue;
      const surfId = h.object.userData?.surface_id;
      if (!surfId) continue;
      bestRoomDist = h.distance;
      bestSurfId = surfId;
      break;
    }
  }
  // Click-empty (no wall hit at all) — drop selection so users can dismiss
  // a sticky highlight without going through the panel. Matches the
  // sub-structure click-empty pattern at onSubStructureClick.
  if (!bestSurfId) {
    if (_selectedSurfaceId) setSurfaceSelectionHighlight(null);
    return;
  }

  // If a speaker (or rack, listener marker) is between the camera and the
  // wall, the click was about that speaker — bail. onSpeakerClick already
  // ran and handled it.
  if (sourcesGroup) {
    const sHits = _surfaceClickRay.intersectObject(sourcesGroup, true);
    for (const h of sHits) {
      if (h.object.userData?.speakerModelUrl && h.distance < bestRoomDist) return;
    }
  }
  // Toggle: clicking the already-selected wall deselects it.
  const next = (bestSurfId === _selectedSurfaceId) ? null : bestSurfId;
  setSurfaceSelectionHighlight(next);
  if (next) emit('surface:picked', { surface_id: next });
}

// ---- Surface hover from side-panel ------------------------------------
// Reverse direction: hovering a wall row in the Room panel emissive-boosts
// the matching mesh in 3D so the user can scan a long wall list and see
// which is which. Mutates material.emissive on every matching mesh in
// roomGroup; restored when surface_id is null (pointerleave) or another
// row is hovered. Cheap — no raycast, just a tree walk on roomGroup.
let _hoveredSurfaceId = null;
const _hoveredSurfaceMeshes = [];
const _surfaceHoverColor = new THREE.Color(0xffd000);
const _surfaceHoverBoost = 0.55;
function setSurfaceHoverHighlight(surfaceId) {
  if (_hoveredSurfaceId === surfaceId) return;
  // Restore previously highlighted meshes — but if a mesh also belongs to
  // the currently SELECTED surface, restore to the selection cyan instead
  // of the bare original emissive (so leaving hover doesn't visually
  // deselect the wall).
  const prevHoveredId = _hoveredSurfaceId;
  for (const m of _hoveredSurfaceMeshes) {
    const store = m.userData;
    if (store._surfOrigEmissiveHex !== undefined && m.material?.emissive) {
      m.material.emissive.setHex(store._surfOrigEmissiveHex);
      m.material.emissiveIntensity = store._surfOrigEmissiveIntensity ?? 1;
      m.material.needsUpdate = true;
      delete store._surfOrigEmissiveHex;
      delete store._surfOrigEmissiveIntensity;
    }
  }
  _hoveredSurfaceMeshes.length = 0;
  // If we just unhovered the selected wall, repaint its selection tint.
  if (prevHoveredId && prevHoveredId === _selectedSurfaceId) {
    _applySurfaceSelectionMaterial(_selectedSurfaceId);
  }
  _hoveredSurfaceId = surfaceId;
  if (!surfaceId || !roomGroup) return;
  // If the hover target is also the selected wall, strip the selection
  // emissive first so the hover stash captures the bare original (otherwise
  // hover-out would restore to "cyan tint" which is fine, but the stash
  // tracker would point at cyan, breaking the next selection clear).
  if (surfaceId === _selectedSurfaceId) _clearSurfaceSelectionMaterial();
  roomGroup.traverse(m => {
    if (!m.isMesh || m.userData?.surface_id !== surfaceId) return;
    if (!m.material || !m.material.emissive) return;
    const store = m.userData;
    store._surfOrigEmissiveHex = m.material.emissive.getHex();
    store._surfOrigEmissiveIntensity = m.material.emissiveIntensity ?? 1;
    m.material.emissive.copy(_surfaceHoverColor);
    m.material.emissiveIntensity = (store._surfOrigEmissiveIntensity ?? 1) + _surfaceHoverBoost;
    m.material.needsUpdate = true;
    _hoveredSurfaceMeshes.push(m);
  });
}
on('surface:hover', ({ surface_id } = {}) => {
  setSurfaceHoverHighlight(surface_id ?? null);
});
// Room rebuilds discard the meshes we cached references to — clear stale
// highlights so subsequent setSurfaceHoverHighlight() calls don't try to
// touch disposed materials.
on('room:changed', () => {
  _hoveredSurfaceMeshes.length = 0;
  _hoveredSurfaceId = null;
});

// ---- Surface click-to-select (sticky highlight) -----------------------
// Cyan (0x00d4ff) is the colour-wheel opposite of the warm-gold hover, so
// the two layers stay distinguishable when stacked. The edge overlay lives
// in its own scene-level group with depthTest=false so it draws on top of
// the floor heatmap and stays visible on every wall material.
const _selectionColor = new THREE.Color(0x00d4ff);
const _selectionBoost = 0.7;
const _selectedSurfaceMeshes = [];
let _selectedSurfaceId = null;
let _selectionEdgeGroup = null;
const _selectionEdgeLines = [];

function _ensureSelectionEdgeGroup() {
  if (_selectionEdgeGroup || !scene) return;
  _selectionEdgeGroup = new THREE.Group();
  _selectionEdgeGroup.name = 'surfaceSelectionEdges';
  _selectionEdgeGroup.renderOrder = 999;
  scene.add(_selectionEdgeGroup);
}

function _disposeSelectionEdges() {
  for (const line of _selectionEdgeLines) {
    line.parent?.remove(line);
    line.geometry?.dispose();
    line.material?.dispose();
  }
  _selectionEdgeLines.length = 0;
}

function _clearSurfaceSelectionMaterial() {
  for (const m of _selectedSurfaceMeshes) {
    const store = m.userData;
    if (store._selSurfOrigEmissiveHex !== undefined && m.material?.emissive) {
      m.material.emissive.setHex(store._selSurfOrigEmissiveHex);
      m.material.emissiveIntensity = store._selSurfOrigEmissiveIntensity ?? 1;
      m.material.needsUpdate = true;
      delete store._selSurfOrigEmissiveHex;
      delete store._selSurfOrigEmissiveIntensity;
    }
  }
  _selectedSurfaceMeshes.length = 0;
}

function _applySurfaceSelectionMaterial(surfaceId) {
  if (!surfaceId || !roomGroup) return;
  roomGroup.traverse(m => {
    if (!m.isMesh || m.userData?.surface_id !== surfaceId) return;
    if (!m.material || !m.material.emissive) {
      _selectedSurfaceMeshes.push(m);
      return;
    }
    // Skip stash if hover is currently overriding the emissive on this mesh
    // — hover-out path will re-apply selection.
    if (m.userData._surfOrigEmissiveHex === undefined) {
      m.userData._selSurfOrigEmissiveHex = m.material.emissive.getHex();
      m.userData._selSurfOrigEmissiveIntensity = m.material.emissiveIntensity ?? 1;
      m.material.emissive.copy(_selectionColor);
      m.material.emissiveIntensity = (m.userData._selSurfOrigEmissiveIntensity ?? 1) + _selectionBoost;
      m.material.needsUpdate = true;
    }
    _selectedSurfaceMeshes.push(m);
  });
}

function _buildSelectionEdgesFor(surfaceId) {
  _disposeSelectionEdges();
  if (!surfaceId || !roomGroup) return;
  _ensureSelectionEdgeGroup();
  if (!_selectionEdgeGroup) return;
  roomGroup.traverse(m => {
    if (!m.isMesh || m.userData?.surface_id !== surfaceId) return;
    if (!m.geometry) return;
    const edgesGeo = new THREE.EdgesGeometry(m.geometry, 12);
    const mat = new THREE.LineBasicMaterial({
      color: _selectionColor,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
      linewidth: 1,
    });
    const line = new THREE.LineSegments(edgesGeo, mat);
    line.renderOrder = 999;
    m.updateWorldMatrix(true, false);
    line.applyMatrix4(m.matrixWorld);
    _selectionEdgeGroup.add(line);
    _selectionEdgeLines.push(line);
  });
}

export function setSurfaceSelectionHighlight(surfaceId) {
  if (_selectedSurfaceId === surfaceId) return;
  _clearSurfaceSelectionMaterial();
  _disposeSelectionEdges();
  _selectedSurfaceId = surfaceId ?? null;
  state.selectedSurfaceId = _selectedSurfaceId;
  if (!_selectedSurfaceId) return;
  _applySurfaceSelectionMaterial(_selectedSurfaceId);
  _buildSelectionEdgesFor(_selectedSurfaceId);
}

// Slow sine pulse (1.5 s period) on the edge-line opacity, driven from
// animate(). Range 0.55–1.0 — visible without being seizure-bait.
function _tickSurfaceSelectionPulse(ts) {
  if (_selectionEdgeLines.length === 0) return;
  const phase = ((ts || performance.now()) / 1500) * Math.PI * 2;
  const opacity = 0.775 + Math.sin(phase) * 0.225;
  for (const line of _selectionEdgeLines) {
    if (line.material) line.material.opacity = opacity;
  }
}

// Re-resolve mesh references after a room rebuild discards the old ones.
on('room:changed', () => {
  _selectedSurfaceMeshes.length = 0;
  _disposeSelectionEdges();
  if (_selectedSurfaceId) {
    requestAnimationFrame(() => {
      if (!_selectedSurfaceId) return;
      _applySurfaceSelectionMaterial(_selectedSurfaceId);
      _buildSelectionEdgesFor(_selectedSurfaceId);
    });
  }
});
on('scene:reset', () => {
  _selectedSurfaceMeshes.length = 0;
  _disposeSelectionEdges();
  _selectedSurfaceId = null;
  state.selectedSurfaceId = null;
});

// Esc / global cancel — drop surface selection along with other transient UI.
document.addEventListener('ui:cancel', () => {
  if (_selectedSurfaceId) setSurfaceSelectionHighlight(null);
});

// ---- Sub-structure click-to-select ------------------------------------
// Clicking a placed sub-room in the 3D viewport selects it as a single
// unit. We raycast roomGroup, walk up the parent chain to the Group with
// userData.tag === 'sub_structure', read userData.sub_id, and update
// state.selectedSubStructureId. Speaker hits beat sub hits when closer
// (same priority rule onSurfaceClick uses for walls). Click-empty in
// 3D deselects so the user can dismiss without going through the chip.
//
// Highlight: emissive boost on every Mesh in the sub-structure Group,
// matching the speaker pattern (setSpeakerHighlight). Tracks the boosted
// meshes so we can restore on deselect / reselect / room-rebuild.
const _subClickRay = new THREE.Raycaster();
const _subClickNdc = { x: 0, y: 0 };
const _subHighlightColor = new THREE.Color(0x4aa3ff);  // ghost-blue (matches sub fill)
const _subHighlightBoost = 0.6;
const _subHighlightedMeshes = [];
let _highlightedSubId = null;

function findSubStructureGroup(obj) {
  // Walk up from a hit mesh until we find the Group tagged 'sub_structure'.
  let o = obj;
  while (o && o !== roomGroup) {
    if (o.userData?.tag === 'sub_structure' && typeof o.userData?.sub_id === 'string') return o;
    o = o.parent;
  }
  return null;
}

function clearSubStructureHighlight() {
  for (const m of _subHighlightedMeshes) {
    const store = m.userData;
    if (store._subOrigEmissiveHex !== undefined && m.material?.emissive) {
      m.material.emissive.setHex(store._subOrigEmissiveHex);
      m.material.emissiveIntensity = store._subOrigEmissiveIntensity ?? 1;
      m.material.needsUpdate = true;
      delete store._subOrigEmissiveHex;
      delete store._subOrigEmissiveIntensity;
    }
  }
  _subHighlightedMeshes.length = 0;
  _highlightedSubId = null;
}

function applySubStructureHighlight(subId) {
  // Sub meshes use MeshBasicMaterial (see buildSubStructureGroup). Basic
  // materials have no .emissive — they'd stay un-highlighted. To get a
  // visible selection cue we boost the material .opacity instead AND add
  // a contrasting tint via the .color stash. Matches the speaker pattern's
  // intent (visual contrast on selection) without forcing a material swap.
  if (!roomGroup) return;
  clearSubStructureHighlight();
  if (!subId) return;
  roomGroup.traverse(o => {
    if (!o.isMesh) return;
    let p = o;
    let inSelectedSub = false;
    while (p && p !== roomGroup) {
      if (p.userData?.tag === 'sub_structure' && p.userData?.sub_id === subId) {
        inSelectedSub = true; break;
      }
      p = p.parent;
    }
    if (!inSelectedSub) return;
    if (!o.material) return;
    const mat = o.material;
    const store = o.userData;
    if (mat.emissive) {
      // Standard material — emissive boost (same as speaker).
      store._subOrigEmissiveHex = mat.emissive.getHex();
      store._subOrigEmissiveIntensity = mat.emissiveIntensity ?? 1;
      mat.emissive.copy(_subHighlightColor);
      mat.emissiveIntensity = (store._subOrigEmissiveIntensity ?? 1) + _subHighlightBoost;
    } else if (mat.color) {
      // Basic material — bump opacity and tint the color toward ghost-blue.
      store._subOrigEmissiveHex = mat.color.getHex();
      store._subOrigEmissiveIntensity = mat.opacity ?? 1;
      mat.color.copy(_subHighlightColor);
      mat.opacity = Math.min(1, (store._subOrigEmissiveIntensity ?? 0.22) + 0.25);
    } else {
      return;
    }
    mat.needsUpdate = true;
    _subHighlightedMeshes.push(o);
  });
  _highlightedSubId = subId;
}

function onSubStructureClick(e) {
  if (walkMode || probeActive || !roomGroup) return;
  if (e.button !== 0) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _subClickNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _subClickNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _subClickRay.setFromCamera(_subClickNdc, activeCamera || camera);

  // Speaker priority: if a speaker is closer than any sub-structure hit,
  // bail — onSpeakerClick already handled the click.
  let speakerDist = Infinity;
  if (sourcesGroup) {
    const sHits = _subClickRay.intersectObject(sourcesGroup, true);
    for (const h of sHits) {
      if (h.object.userData?.speakerModelUrl) { speakerDist = h.distance; break; }
    }
  }

  const roomHits = _subClickRay.intersectObject(roomGroup, true);
  let pickedSubId = null;
  let pickedDist = Infinity;
  for (const h of roomHits) {
    const tag = h.object.userData?.tag ?? '';
    if (tag.startsWith('heatmap_')) continue;
    const subGroup = findSubStructureGroup(h.object);
    if (!subGroup) continue;
    if (h.distance < speakerDist) {
      pickedSubId = subGroup.userData.sub_id;
      pickedDist = h.distance;
    }
    break;
  }

  // If user clicked through to a non-sub surface that's CLOSER than any
  // sub hit, that's a click-empty (or a parent-wall click) — clear sub
  // selection so users can dismiss without going to the chip. The
  // surface-pulse path (onSurfaceClick) keeps running independently.
  if (pickedSubId === null) {
    if (state.selectedSubStructureId != null) {
      state.selectedSubStructureId = null;
      clearSubStructureHighlight();
      emit('sub_structure:selected', { id: null });
    }
    return;
  }

  // New selection. Toggle off if clicking the already-selected sub.
  const next = (pickedSubId === state.selectedSubStructureId) ? null : pickedSubId;
  state.selectedSubStructureId = next;
  if (next) applySubStructureHighlight(next);
  else clearSubStructureHighlight();
  emit('sub_structure:selected', { id: next });
}

// Restore highlight after a room-rebuild discards the meshes we cached.
on('room:changed', () => {
  _subHighlightedMeshes.length = 0;
  _highlightedSubId = null;
  if (state.selectedSubStructureId) {
    // Defer until after the rebuild lands new meshes — queueRebuild is
    // RAF-coalesced, so wait one frame.
    requestAnimationFrame(() => {
      if (state.selectedSubStructureId) applySubStructureHighlight(state.selectedSubStructureId);
    });
  }
});
on('scene:reset', () => {
  _subHighlightedMeshes.length = 0;
  _highlightedSubId = null;
});

function onProbeMouseMove(e) {
  if (!probeActive || walkMode) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _probeMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _probeMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  probeRaycaster.setFromCamera(_probeMouse, activeCamera || camera);
  const hits = probeRaycaster.intersectObject(roomGroup, true);
  // Skip heatmap layers.
  let hit = null;
  for (const h of hits) {
    const tag = h.object.userData?.tag ?? '';
    if (tag.startsWith('heatmap_')) continue;
    hit = h; break;
  }
  if (!hit) {
    probeMarker.visible = false;
    probeTooltip.classList.add('hidden');
    return;
  }
  // Marker at hit point.
  probeMarker.position.copy(hit.point);
  probeMarker.visible = true;

  // Compute SPL at the hit point, using current physics options.
  // state-frame listener position: x→x, y→world-Z, z→world-Y (plus 1.2 m ear offset).
  const listenerPos = {
    x: hit.point.x,
    y: hit.point.z,
    z: hit.point.y + 1.2,
  };
  const flat = expandSources(state.sources);
  const spl = flat.length > 0 ? computeMultiSourceSPL({
    sources: flat,
    getSpeakerDef: url => getCachedLoudspeaker(url),
    listenerPos, room: state.room,
    ...currentPhysicsOpts(state.room),
  }) : NaN;

  probeTooltip.classList.remove('hidden');
  probeTooltip.style.left = (e.clientX - rect.left + 14) + 'px';
  probeTooltip.style.top  = (e.clientY - rect.top + 14) + 'px';
  const eqOn = !!state.physics?.eq?.enabled;
  probeTooltip.innerHTML = `
    <div class="probe-spl">${isFinite(spl) ? spl.toFixed(1) + ' dB' : '—'}</div>
    <div class="probe-xyz">
      <span>x ${listenerPos.x.toFixed(2)} m</span>
      <span>y ${listenerPos.y.toFixed(2)} m</span>
      <span>z ${(hit.point.y).toFixed(2)} m</span>
    </div>
    <div class="probe-note">ear @ 1.2 m</div>
    ${eqOn ? '<div class="probe-fr-wrap"><canvas class="probe-fr-chart" width="200" height="90"></canvas><div class="probe-fr-label">Frequency response · 20 Hz – 20 kHz</div></div>' : ''}
  `;
  if (eqOn && flat.length > 0) {
    const canvas = probeTooltip.querySelector('.probe-fr-chart');
    if (canvas) drawFrequencyResponse(canvas, flat, listenerPos);
  }
}

// Compute + render a frequency-response curve at the probed point. Samples
// 48 log-spaced frequencies from 20 Hz to 20 kHz, evaluating the current
// multi-source SPL with the current master EQ applied per-frequency. Room
// constant R at each sample frequency is interpolated from the 7 physics
// bands (125–8k) so we don't walk the surface list 48× per mousemove.
const FR_SAMPLE_COUNT = 48;
const FR_MIN_HZ = 20;
const FR_MAX_HZ = 20000;
const _frSampleCache = { freqs: null };
function getFRSampleFreqs() {
  if (_frSampleCache.freqs) return _frSampleCache.freqs;
  const arr = new Float64Array(FR_SAMPLE_COUNT);
  const ln = Math.log(FR_MAX_HZ / FR_MIN_HZ);
  for (let i = 0; i < FR_SAMPLE_COUNT; i++) {
    const t = i / (FR_SAMPLE_COUNT - 1);
    arr[i] = FR_MIN_HZ * Math.exp(t * ln);
  }
  _frSampleCache.freqs = arr;
  return arr;
}
function interpR(freq_hz, Rbands) {
  // Rbands is an array of {f, R}. Log-freq interp.
  if (freq_hz <= Rbands[0].f) return Rbands[0].R;
  if (freq_hz >= Rbands[Rbands.length - 1].f) return Rbands[Rbands.length - 1].R;
  for (let i = 0; i < Rbands.length - 1; i++) {
    const a = Rbands[i], b = Rbands[i + 1];
    if (freq_hz >= a.f && freq_hz <= b.f) {
      const t = Math.log(freq_hz / a.f) / Math.log(b.f / a.f);
      return a.R + t * (b.R - a.R);
    }
  }
  return 0;
}
function drawFrequencyResponse(canvas, sources, listenerPos) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const freqs = getFRSampleFreqs();
  const phys = state.physics ?? {};
  const reverbOn = phys.reverberantField && materialsRef;
  // Pre-compute room constant R at the 7 physics bands once, interpolate for
  // the 48 sample frequencies. Avoids walking the surface list 48 times.
  const Rbands = reverbOn
    ? [125, 250, 500, 1000, 2000, 4000, 8000].map(f => ({
        f, R: computeRoomConstant(state.room, materialsRef, f, state.zones, { treatments: state.treatments }),
      }))
    : null;

  const getDef = url => getCachedLoudspeaker(url);
  const spls = new Float32Array(FR_SAMPLE_COUNT);
  let minSPL = Infinity, maxSPL = -Infinity;
  for (let i = 0; i < FR_SAMPLE_COUNT; i++) {
    const f = freqs[i];
    const R = Rbands ? interpR(f, Rbands) : 0;
    const spl = computeMultiSourceSPL({
      sources, getSpeakerDef: getDef, listenerPos,
      freq_hz: f, room: state.room,
      airAbsorption: phys.airAbsorption !== false,
      coherent: !!phys.coherent,
      roomConstantR: R,
      eqGainDb: eqGainAt(phys.eq, f),
    });
    spls[i] = spl;
    if (isFinite(spl)) {
      if (spl < minSPL) minSPL = spl;
      if (spl > maxSPL) maxSPL = spl;
    }
  }
  // Auto-scale with ≥20 dB vertical range so small variations don't look huge
  // and large variations don't clip.
  if (!isFinite(minSPL) || !isFinite(maxSPL)) return;
  const span = Math.max(20, maxSPL - minSPL + 6);
  const mid = (minSPL + maxSPL) / 2;
  const yMin = mid - span / 2;
  const yMax = mid + span / 2;

  // Grid: horizontal dB lines every 10 dB, vertical log-decade lines.
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let db = Math.ceil(yMin / 10) * 10; db <= yMax; db += 10) {
    const y = H - ((db - yMin) / (yMax - yMin)) * H;
    ctx.moveTo(0, y); ctx.lineTo(W, y);
  }
  const lnRange = Math.log(FR_MAX_HZ / FR_MIN_HZ);
  for (const dec of [100, 1000, 10000]) {
    const x = (Math.log(dec / FR_MIN_HZ) / lnRange) * W;
    ctx.moveTo(x, 0); ctx.lineTo(x, H);
  }
  ctx.stroke();

  // Decade labels.
  ctx.fillStyle = 'rgba(200, 210, 220, 0.55)';
  ctx.font = '9px monospace';
  ctx.textBaseline = 'bottom';
  for (const [dec, label] of [[100, '100'], [1000, '1k'], [10000, '10k']]) {
    const x = (Math.log(dec / FR_MIN_HZ) / lnRange) * W;
    ctx.fillText(label, x + 2, H - 1);
  }

  // FR curve (accent cyan).
  ctx.strokeStyle = '#4aa3ff';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let i = 0; i < FR_SAMPLE_COUNT; i++) {
    const t = i / (FR_SAMPLE_COUNT - 1);
    const x = t * W;
    const y = H - ((spls[i] - yMin) / (yMax - yMin)) * H;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Y-axis span indicator (min / max dB).
  ctx.fillStyle = 'rgba(200, 210, 220, 0.75)';
  ctx.font = '9px monospace';
  ctx.textBaseline = 'top';
  ctx.fillText(`${maxSPL.toFixed(0)} dB`, 2, 1);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${minSPL.toFixed(0)} dB`, 2, H - 1);
}

// Suited-man avatar built from primitives — ~1.78 m tall with realistic
// proportions (1/8 head rule), facial features, and joint-group structure
// so arms/legs can swing around shoulder/hip pivots during walk animation.
//
// Hierarchy:
//   avatar (root)
//     body           (non-moving parts: head, torso, pelvis, tie, etc.)
//     armL, armR     (Groups pivoting at shoulder)
//     legL, legR     (Groups pivoting at hip)
// avatarParts captures the swinging groups so tickWalkthrough() can drive
// their rotation.x without walking the scene graph every frame.
function buildSuitedManAvatar() {
  const SKIN      = 0xd9b798;
  const STUBBLE   = 0x3a2c20;
  const SUIT      = 0x0a0b10;
  const SUIT_HI   = 0x121319;
  const LAPEL     = 0x05060a;
  const SHIRT     = 0x18181c;
  const TIE       = 0x05050a;
  const PANTS     = 0x080911;
  const SHOE      = 0x050505;
  const HAIR      = 0x120a06;

  const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({
    color,
    roughness: opts.r ?? 0.78,
    metalness: opts.m ?? 0.04,
  });
  const suitMat = mat(SUIT, { r: 0.62, m: 0.06 });
  const suitHiMat = mat(SUIT_HI, { r: 0.55, m: 0.08 });
  const lapelMat = mat(LAPEL, { r: 0.45, m: 0.10 });
  const shirtMat = mat(SHIRT, { r: 0.55, m: 0.05 });
  const tieMat = mat(TIE, { r: 0.40, m: 0.15 });
  const pantsMat = mat(PANTS, { r: 0.70, m: 0.05 });
  const shoeMat = mat(SHOE, { r: 0.22, m: 0.30 });
  const skinMat = mat(SKIN, { r: 0.55, m: 0.02 });
  const hairMat = mat(HAIR, { r: 0.65, m: 0.05 });
  const stubbleMat = mat(STUBBLE, { r: 0.85, m: 0.0 });

  const mesh = (geo, m, pos, rot) => {
    const x = new THREE.Mesh(geo, m);
    if (pos) x.position.set(pos[0], pos[1], pos[2]);
    if (rot) x.rotation.set(rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0);
    x.castShadow = true;
    x.receiveShadow = true;
    return x;
  };

  const root = new THREE.Group();
  const parts = {
    armL: null, armR: null, legL: null, legR: null,
    body: new THREE.Group(),
    spine: new THREE.Group(),
  };
  parts.spine.position.set(0, 0.92, 0);
  parts.body.position.y = -0.92;
  parts.spine.add(parts.body);
  root.add(parts.spine);

  // --- Head: cranium + jaw, slicked-back hair wedge, beard layer ---
  const headG = new THREE.Group();
  headG.position.set(0, 1.54, 0);

  // Cranium — egg-shaped, slightly elongated front-back.
  const cranium = mesh(new THREE.SphereGeometry(0.115, 28, 24), skinMat, [0, 0.13, 0]);
  cranium.scale.set(0.96, 1.12, 1.02);
  headG.add(cranium);

  // Jaw — narrower lower oval pulled forward to break the perfect-egg silhouette.
  const jaw = mesh(new THREE.SphereGeometry(0.085, 22, 18), skinMat, [0, 0.06, 0.012]);
  jaw.scale.set(0.85, 0.78, 0.95);
  headG.add(jaw);

  // Stubble / short beard — covers the lower jaw + chin, slightly oversized
  // so it reads as a layer when seen against the skin tone behind it.
  const beard = mesh(new THREE.SphereGeometry(0.087, 22, 18), stubbleMat, [0, 0.055, 0.012]);
  beard.scale.set(0.88, 0.62, 0.98);
  headG.add(beard);

  // Hair — slicked-back wedge: a half-sphere offset BACKWARD, then squashed
  // forward-low to suggest combed-back volume. Reads as "dark hair pulled
  // back" rather than "swim cap".
  const hair = mesh(
    new THREE.SphereGeometry(0.123, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.55),
    hairMat,
    [0, 0.155, -0.018],
  );
  hair.scale.set(1.02, 0.92, 1.10);
  headG.add(hair);

  // Sideburn hint — short tapered hair strips on each side at temple level,
  // catches the eye when the camera is behind/above.
  for (const sx of [-1, 1]) {
    const burn = mesh(new THREE.BoxGeometry(0.018, 0.055, 0.040), hairMat,
      [sx * 0.108, 0.135, -0.005]);
    headG.add(burn);
  }

  parts.body.add(headG);

  // --- Neck ---
  parts.body.add(mesh(new THREE.CylinderGeometry(0.046, 0.052, 0.085, 14), skinMat, [0, 1.498, 0]));

  // --- Torso: jacket as a tapered V, with separate shoulder caps that round
  // out the silhouette so the upper body doesn't look like a cylinder ---
  const jacket = mesh(new THREE.CylinderGeometry(0.18, 0.145, 0.56, 22), suitMat, [0, 1.17, 0]);
  jacket.scale.set(1.0, 1.0, 0.72);
  parts.body.add(jacket);

  // Shoulder caps — half-spheres at each shoulder. Adds visible roundness
  // where the arm meets the jacket; without these the cylinder looks naked.
  for (const sx of [-1, 1]) {
    const cap = mesh(
      new THREE.SphereGeometry(0.085, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.55),
      suitHiMat,
      [sx * 0.165, 1.42, 0],
    );
    cap.scale.set(1.05, 0.85, 0.95);
    parts.body.add(cap);
  }

  // Shirt V — visible triangle of dark shirt at the chest opening between
  // the lapels. A thin flat box angled forward.
  const shirtV = mesh(new THREE.BoxGeometry(0.080, 0.18, 0.012), shirtMat,
    [0, 1.32, 0.108], [0.15, 0, 0]);
  parts.body.add(shirtV);

  // Tie — narrow strip running from collar to mid-chest. Slightly wider at
  // the bottom (hint of a tie knot + blade).
  const tieKnot = mesh(new THREE.BoxGeometry(0.034, 0.030, 0.014), tieMat,
    [0, 1.41, 0.116]);
  parts.body.add(tieKnot);
  const tieBlade = mesh(new THREE.BoxGeometry(0.030, 0.20, 0.011), tieMat,
    [0, 1.30, 0.112], [0.15, 0, 0]);
  parts.body.add(tieBlade);

  // Lapels — two angled flat boxes flanking the shirt-V. Each is rotated
  // outward around Y so the inner edges form a V-notch typical of a 2-button
  // suit. This is the single biggest "is wearing a suit" cue at distance.
  for (const sx of [-1, 1]) {
    const lapel = mesh(new THREE.BoxGeometry(0.075, 0.30, 0.014), lapelMat,
      [sx * 0.052, 1.30, 0.106], [0.10, sx * 0.18, sx * -0.18]);
    parts.body.add(lapel);
  }

  // Pelvis band + belt — visible at the waist break.
  const pelvis = mesh(new THREE.CylinderGeometry(0.16, 0.17, 0.13, 16), pantsMat, [0, 0.86, 0]);
  pelvis.scale.z = 0.72;
  parts.body.add(pelvis);
  const belt = mesh(new THREE.CylinderGeometry(0.174, 0.174, 0.026, 18), mat(0x050505, { r: 0.25, m: 0.35 }),
    [0, 0.928, 0]);
  belt.scale.z = 0.72;
  parts.body.add(belt);
  // Belt buckle — small flat reflective square front-center.
  const buckle = mesh(new THREE.BoxGeometry(0.040, 0.024, 0.006), mat(0x2a2a2e, { r: 0.30, m: 0.65 }),
    [0, 0.928, 0.130]);
  parts.body.add(buckle);

  // --- Arm factory: shoulder → elbow → forearm/hand. Cuff at wrist. ---
  const makeArm = (sign) => {
    const arm = new THREE.Group();
    arm.position.set(sign * 0.20, 1.42, 0);
    // Upper sleeve.
    arm.add(mesh(new THREE.CylinderGeometry(0.058, 0.046, 0.27, 14), suitMat, [0, -0.135, 0]));
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.27, 0);
    arm.add(elbow);
    // Forearm sleeve.
    elbow.add(mesh(new THREE.CylinderGeometry(0.046, 0.040, 0.24, 14), suitMat, [0, -0.12, 0]));
    // Cuff — thin shirt-color band peeking past the sleeve.
    elbow.add(mesh(new THREE.CylinderGeometry(0.041, 0.041, 0.018, 14), shirtMat, [0, -0.245, 0]));
    // Hand — flattened oval.
    const hand = mesh(new THREE.SphereGeometry(0.048, 14, 12), skinMat, [0, -0.29, 0]);
    hand.scale.set(0.65, 1.25, 0.55);
    elbow.add(hand);
    arm.userData.elbow = elbow;
    return arm;
  };
  parts.armL = makeArm(-1);
  parts.armR = makeArm( 1);
  parts.armL.position.y -= 0.92;
  parts.armR.position.y -= 0.92;
  parts.spine.add(parts.armL, parts.armR);

  // --- Leg factory: hip → knee → shin/shoe. Cuff hint at ankle. ---
  const makeLeg = (sign) => {
    const leg = new THREE.Group();
    leg.position.set(sign * 0.11, 0.86, 0);
    leg.add(mesh(new THREE.CylinderGeometry(0.078, 0.064, 0.42, 14), pantsMat, [0, -0.21, 0]));
    const knee = new THREE.Group();
    knee.position.set(0, -0.42, 0);
    leg.add(knee);
    knee.add(mesh(new THREE.CylinderGeometry(0.060, 0.052, 0.40, 14), pantsMat, [0, -0.22, 0]));
    // Pant cuff break — thin band at ankle.
    knee.add(mesh(new THREE.CylinderGeometry(0.054, 0.054, 0.024, 14), pantsMat, [0, -0.418, 0]));
    // Shoe — flattened ellipsoid, lower to the ground, shinier than fabric.
    const shoe = mesh(new THREE.SphereGeometry(0.095, 18, 12), shoeMat, [0, -0.452, 0.035]);
    shoe.scale.set(0.60, 0.42, 1.40);
    knee.add(shoe);
    leg.userData.knee = knee;
    return leg;
  };
  parts.legL = makeLeg(-1);
  parts.legR = makeLeg( 1);
  root.add(parts.legL, parts.legR);

  // Ensure shadow flags are set on every mesh (the helper sets them per-mesh
  // already, but groups added later via traverse-style code might miss them).
  root.traverse(o => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });

  root.visible = false;
  root.userData.tag = 'walk_avatar';
  avatarParts = parts;
  return root;
}

// -------------------------------------------------------------------------
// Walkable terrain height lookup: given (x, y) in state coords, return the
// concrete z-level under that point so the avatar can climb the stadium
// tiers instead of clipping through them. Handles court floor (0), lower
// bowl stepped tiers, concourse plateau, upper bowl stepped tiers, and
// vomitory tunnels. Non-stadium presets fall through to z=0 (flat floor).
// -------------------------------------------------------------------------
function terrainHeightAt(x, y, room) {
  if (!room) return 0;
  const s = room.stadiumStructure;
  if (!s) return 0;
  const dx = x - s.cx;
  const dy = y - s.cy;
  const r = Math.hypot(dx, dy);

  // Vomitory passages stay at z=0 regardless of radius — they're tunnels
  // that pass under the concourse from the court to the outside ring.
  const vom = s.vomitories;
  if (vom?.centerAnglesDeg?.length && vom.widthDeg > 0) {
    const halfWidth = (vom.widthDeg / 2) * Math.PI / 180;
    const angle = Math.atan2(dy, dx);
    for (const cDeg of vom.centerAnglesDeg) {
      let diff = angle - (cDeg * Math.PI / 180);
      while (diff >  Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      if (Math.abs(diff) < halfWidth) return 0;
    }
  }

  // Inside lower bowl inner radius → open court floor.
  const lb = s.lowerBowl;
  if (lb && r < lb.r_in) return 0;
  // Lower bowl stepped tiers
  if (lb && r >= lb.r_in && r < lb.r_out) {
    const tread = (lb.r_out - lb.r_in) / lb.tier_heights_m.length;
    const t = Math.min(lb.tier_heights_m.length - 1, Math.floor((r - lb.r_in) / tread));
    return lb.tier_heights_m[t];
  }
  // Concourse flat ring
  const co = s.concourse;
  if (co && r >= co.r_in && r < co.r_out) return co.elevation_m;
  // Upper bowl stepped tiers
  const ub = s.upperBowl;
  if (ub && r >= ub.r_in && r < ub.r_out) {
    const tread = (ub.r_out - ub.r_in) / ub.tier_heights_m.length;
    const t = Math.min(ub.tier_heights_m.length - 1, Math.floor((r - ub.r_in) / tread));
    return ub.tier_heights_m[t];
  }
  // Service corridor / back wall area — treat as ground level.
  return 0;
}


function initWalkthrough() {
  const w = Math.max(container.clientWidth, 1);
  const h = Math.max(container.clientHeight, 1);
  walkCamera = new THREE.PerspectiveCamera(55, w / h, 0.05, 300);

  avatar = buildSuitedManAvatar();
  scene.add(avatar);

  // Control-hint overlay (hidden until walk mode is active).
  walkHint = document.createElement('div');
  walkHint.className = 'walk-hint hidden';
  walkHint.id = 'walk-hint';
  walkHint.innerHTML = `
    <strong>Walkthrough</strong>
    <span>W / A / S / D — move (camera-relative)</span>
    <span>Mouse drag — orbit camera</span>
    <span>Mouse wheel — zoom</span>
    <span>Space — jump · C / Ctrl — crouch (hold)</span>
    <span>Z — sit / stand · Shift — run · R — reset</span>
  `;
  container.appendChild(walkHint);

  // Live SPL readout at the avatar's ear position (top-right).
  walkSplOverlay = document.createElement('div');
  walkSplOverlay.className = 'walk-spl hidden';
  walkSplOverlay.id = 'walk-spl';
  walkSplOverlay.innerHTML = `
    <div class="walk-spl-big">— dB</div>
    <div class="walk-spl-sti"><span class="walk-spl-label">STI</span><span class="walk-spl-val" data-f="sti">—</span></div>
    <div class="walk-spl-row"><span class="walk-spl-label">ear</span><span class="walk-spl-val" data-f="ear">— m</span></div>
    <div class="walk-spl-row"><span class="walk-spl-label">pose</span><span class="walk-spl-val" data-f="pose">standing</span></div>
    <div class="walk-spl-row"><span class="walk-spl-label">xyz</span><span class="walk-spl-val" data-f="xyz">—</span></div>
  `;
  container.appendChild(walkSplOverlay);

  // --- ThirdPersonController ------------------------------------------------
  // Owns movement / camera / input / raycast collision. Drives the avatar's
  // position + yaw. We keep the procedural animation layers here in scene.js
  // and wire them in via the onAnimate callback.
  tpController = new ThirdPersonController({
    worldCamera: walkCamera,
    domElement: renderer.domElement,
    // Lazy getter — roomGroup is created by rebuildRoom AFTER initWalkthrough.
    getCollidables: () => roomGroup,
    character: avatar,
  });
  tpController.onJump = () => {
    // Kick off the anticipation phase — state machine fires the actual impulse
    // after the 0.10 s wind-up via controller.jump() below.
    if (animState.jumpPhase === 'grounded') {
      animState.jumpPhase = 'anticipate';
      animState.jumpT = 0;
    }
  };
  tpController.onAnimate = applyAvatarAnimation;

  // Async GLTF character upgrade — if assets/models/hitman.glb exists, swap
  // the procedural avatar for the rigged model + AnimationMixer fast path.
  // HEAD-probe first: a 404 means no asset shipped yet → keep procedural
  // (and skip the loader so DevTools stays clean). On 200, mark the
  // procedural avatar as a transient stand-in: hide it AND show a loading
  // indicator while the GLB streams + DRACO decoder cold-fetches from
  // unpkg (first-visit cost, ~5-15s on a normal connection). When the rig
  // resolves we swap it in; if anything fails we restore procedural.
  riggedAvatarLoading = true;
  fetch('assets/models/hitman.glb', { method: 'HEAD' })
    .then(res => {
      if (!res.ok) throw new Error('no-asset');
      return loadCharacterRig('assets/models/hitman.glb');
    })
    .then(rig => {
      riggedAvatar = rig;
      rig.root.position.copy(avatar.position);
      rig.root.rotation.copy(avatar.rotation);
      // Procedural is hidden during load (when walk mode is active);
      // reveal the rig if walk mode is currently on, leave hidden otherwise.
      rig.root.visible = walkMode;
      scene.remove(avatar);
      scene.add(rig.root);
      tpController.character = rig.root;
      shadowsNeedRefresh = true;
      riggedAvatarLoading = false;
      hideAvatarLoadingOverlay();
    })
    .catch(err => {
      // No asset OR load failed — fall back to procedural.
      riggedAvatarLoading = false;
      hideAvatarLoadingOverlay();
      // Restore procedural avatar visibility based on current walk mode.
      if (avatar) avatar.visible = walkMode;
      if (err?.message !== 'no-asset') {
        console.info('[walkthrough] rigged avatar unavailable:', err?.message ?? err);
      }
    });
}

let riggedAvatarLoading = false;
let _avatarLoadingOverlay = null;

function showAvatarLoadingOverlay() {
  if (_avatarLoadingOverlay) return;
  const v3 = document.getElementById('view-3d');
  if (!v3) return;
  const el = document.createElement('div');
  el.className = 'avatar-loading-overlay';
  el.textContent = 'Loading character…';
  v3.appendChild(el);
  _avatarLoadingOverlay = el;
}

function hideAvatarLoadingOverlay() {
  if (_avatarLoadingOverlay) {
    _avatarLoadingOverlay.remove();
    _avatarLoadingOverlay = null;
  }
}

function placeAvatarAtDefault() {
  const room = state.room;
  const cx = (room.width_m ?? 20) / 2;
  const cy = (room.depth_m ?? 20) / 2;
  const gz = terrainHeightAt(cx, cy, room);
  // State frame (x=width, y=depth, z=height) → Three.js (x, z, y).
  tpController.setPosition(new THREE.Vector3(cx, gz + 0.05, cy));
  tpController.setYaw(0);
  tpController.vy = 0;
  walkPhase = 0;
  animState.jumpPhase = 'grounded';
  animState.jumpT = 0;
  animState.landingAmount = 0;
  animState.turnLean = 0;
  animState.runFactor = 0;
  animState.yawRate = 0;
  animState.crouchF = 0;
  animState.sitting = false;
  animState.sitF = 0;
  animState.sitLatch = false;
  if (tpController) tpController.blockMovement = false;
  animState.prevYaw = tpController.yaw;
}

// Public toggle called by main.js when the user clicks the Walkthrough tab.
export function setWalkthroughMode(on) {
  // Martina audit #20 — if mount3DViewport threw during init, walkCamera
  // / tpController / avatar won't exist, and the user's tab click would
  // silently put us in an inconsistent state. Guard + surface the error.
  if (on && (!walkCamera || !tpController || !avatar)) {
    console.warn('[scene] walkthrough unavailable — 3D viewport failed to mount');
    const v3 = document.getElementById('view-3d');
    if (v3 && !v3.querySelector('.walk-unavailable')) {
      const banner = document.createElement('div');
      banner.className = 'walk-unavailable viewport-loading';
      banner.textContent = 'Walkthrough unavailable — the 3D viewport did not mount.';
      v3.appendChild(banner);
    }
    walkMode = false;
    return;
  }
  walkMode = !!on;
  // Phase W.1 — tell the audition graph whether the avatar is the
  // listener now. setAuditionWalkMode(true) re-anchors the SPL-trim
  // baseline to the avatar on the next pose update AND blocks the
  // sidebar listener-selection event from restarting audition.
  setAuditionWalkMode(walkMode);
  // Show / hide the touch HUD overlay (joystick + action buttons) so
  // tablet users have a usable walk control surface. Desktop users
  // can ignore it (CSS dims to ~55% opacity until hovered).
  if (walkMode) showWalkTouchHUD(); else hideWalkTouchHUD();
  // Toggle a body-level class so CSS can re-position siblings out of
  // the touch-control's way (e.g., the SPL legend was sitting in the
  // bottom-right where the RUN / SIT buttons are, and the legend's
  // gradient bar showed THROUGH the partly-translucent buttons).
  document.documentElement.classList.toggle('is-walkmode', walkMode);
  if (walkMode) {
    placeAvatarAtDefault();
    // Hide the procedural cylinder placeholder while the rigged GLB is
    // streaming — show a "Loading character…" overlay instead so the user
    // doesn't see the ugly fallback rod-figure during the cold-cache
    // ~5-15 s first-visit fetch. When the rig resolves the overlay clears
    // and the rigged mesh becomes visible.
    if (riggedAvatarLoading) {
      avatar.visible = false;
      showAvatarLoadingOverlay();
    } else {
      avatar.visible = true;
    }
    avatar.scale.set(1, 1, 1);
    if (avatarParts?.body) avatarParts.body.rotation.set(0, 0, 0);
    if (avatarParts?.spine) avatarParts.spine.rotation.set(0, 0, 0);
    if (riggedAvatar) riggedAvatar.root.visible = true;
    if (controls) controls.enabled = false;
    activeCamera = walkCamera;
    tpController.enable();
    walkHint?.classList.remove('hidden');
    walkSplOverlay?.classList.remove('hidden');
    tpLastTs = performance.now();
  } else {
    if (avatar) {
      avatar.visible = false;
      avatar.scale.set(1, 1, 1);
      if (avatarParts?.body) avatarParts.body.rotation.set(0, 0, 0);
      if (avatarParts?.spine) avatarParts.spine.rotation.set(0, 0, 0);
    }
    if (riggedAvatar) riggedAvatar.root.visible = false;
    hideAvatarLoadingOverlay();
    if (controls) controls.enabled = true;
    activeCamera = camera;
    tpController?.disable();
    walkHint?.classList.add('hidden');
    walkSplOverlay?.classList.add('hidden');
  }
  onResize();
}

// Fires from the controller's per-frame callback. Runs the 6 procedural
// animation layers (walk cycle / crouch / jump anticipate / airborne apex /
// landing absorb / turn-lean / run pump), applies the combined pose to the
// avatar's body/knee/elbow transforms, and updates the live SPL readout.
// Reset pose state is now fully owned by scene.js (the controller handles
// position/yaw/vy/collision/camera only).
// Input → state-machine transitions. Owns animState.jumpPhase,
// animState.crouchF, animState.sitting / sitF / sitLatch. Runs for both
// avatar paths (rigged GLB and procedural primitives) — the procedural
// path used to embed this inline, but the rigged path skipped it and the
// state flags froze, latching the rigged setState() into Jump forever.
function updateAnimStateMachine(ctx, dt) {
  // Jump state machine. tpController.jump() returns false when the
  // controller refuses (e.g. already airborne). If we set 'airborne'
  // unconditionally we'd wait forever for a justLanded signal that
  // never fires, latching the rigged avatar into the Jump clip.
  if (animState.jumpPhase === 'anticipate') {
    animState.jumpT += dt / 0.10;
    if (animState.jumpT >= 1) {
      animState.jumpT = 0;
      const jumped = tpController.jump(JUMP_VELOCITY_MS);
      animState.jumpPhase = jumped ? 'airborne' : 'grounded';
    }
  } else if (animState.jumpPhase === 'airborne') {
    animState.jumpT += dt;
    if (ctx.justLanded) {
      animState.impactVel = Math.abs(ctx.impactVy);
      animState.landingAmount = Math.min(1, Math.max(0.3, animState.impactVel / 8));
      animState.jumpPhase = 'landing';
      animState.jumpT = 0;
    }
  } else if (animState.jumpPhase === 'landing') {
    animState.jumpT += dt / 0.22;
    if (animState.jumpT >= 1) {
      animState.jumpT = 1;
      animState.jumpPhase = 'grounded';
      animState.landingAmount = 0;
    }
  }

  // Crouch factor
  const crouchHeld = ctx.keys.has('KeyC') || ctx.keys.has('ControlLeft') || ctx.keys.has('ControlRight');
  animState.crouchF += ((crouchHeld ? 1 : 0) - animState.crouchF) * (1 - Math.exp(-dt / 0.12));

  // Sit toggle (Z) — edge-triggered so holding Z doesn't thrash the state.
  const zHeld = ctx.keys.has('KeyZ');
  if (zHeld && !animState.sitLatch) {
    animState.sitting = !animState.sitting;
    animState.sitLatch = true;
    if (tpController) tpController.blockMovement = animState.sitting;
  }
  if (!zHeld) animState.sitLatch = false;
  animState.sitF += ((animState.sitting ? 1 : 0) - animState.sitF) * (1 - Math.exp(-dt / 0.20));
}

function applyAvatarAnimation(ctx) {
  const dt = ctx.dt;

  // Input → state-machine transitions must run for BOTH avatar paths.
  // Previously this lived inline below the early return for the rigged
  // path; with the rigged avatar it never fired so animState.jumpPhase
  // / crouchF / sitting froze and the rigged setState always picked Jump.
  updateAnimStateMachine(ctx, dt);

  // --- Rigged GLTF fast path ---
  // When assets/models/hitman.glb loaded successfully, let the AnimationMixer
  // handle all locomotion via crossfades between idle / walk / run clips and
  // bypass the procedural joint-group pose code (which wouldn't find
  // avatarParts on a SkinnedMesh anyway).
  if (riggedAvatar) {
    riggedAvatar.setState({
      moving:    ctx.moving,
      running:   ctx.running,
      crouching: animState.crouchF > 0.3,
      jumping:   animState.jumpPhase !== 'grounded',
      sitting:   !!animState.sitting,
    });
    riggedAvatar.update(dt);
    // Ear height tracks pose so SPL / STI probed in walk mode reflect
    // the actual listening height. Standing 1.68 m → full crouch ≈ 1.0 m
    // (drop 0.68 m) → sitting on a chair ≈ 1.18 m (drop 0.50 m).
    // crouchF + sitF are 0..1 smoothed factors from updateAnimStateMachine.
    const dynamicEarHeight = AVATAR_EYE_HEIGHT
      - animState.crouchF * 0.68
      - animState.sitF * 0.50;
    if (walkSplOverlay) updateWalkSplReadout(ctx, dynamicEarHeight);
    return;
  }

  // --- Run factor (smoothed) ---
  animState.runFactor += ((ctx.running ? 1 : 0) - animState.runFactor) * (1 - Math.exp(-dt / 0.15));

  // --- Walk cycle phase ---
  const strideHz = 1.7 + animState.runFactor * 0.9;
  if (ctx.moving) walkPhase += dt * Math.PI * 2 * strideHz;
  const legAmp = 0.45 * (1 + animState.runFactor * 0.5);
  const armAmp = 0.35 * (1 + animState.runFactor * 1.1);
  const s_leg = Math.sin(walkPhase);
  const legRotL = ctx.moving ? -s_leg * legAmp : 0;
  const legRotR = ctx.moving ?  s_leg * legAmp : 0;
  const armRotL = ctx.moving ?  s_leg * armAmp : 0;
  const armRotR = ctx.moving ? -s_leg * armAmp : 0;
  const bobAmp = 0.025 + animState.runFactor * 0.015;
  const bob = ctx.moving ? Math.abs(Math.cos(walkPhase)) * bobAmp : 0;

  // --- Turn-lean — body rolls into yaw-rate (cinemachine-style). ---
  let dh = ctx.yaw - animState.prevYaw;
  while (dh >  Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  animState.yawRate += ((dh / Math.max(dt, 0.001)) - animState.yawRate) * 0.2;
  animState.prevYaw = ctx.yaw;
  const leanTarget = Math.max(-0.35, Math.min(0.35, -animState.yawRate * 0.18));
  animState.turnLean += (leanTarget - animState.turnLean) * 0.12;

  // (state machine ran at the top of applyAvatarAnimation)

  // --- Pose accumulation ---
  let bodyScale = 1;
  let thighL_rot = legRotL, thighR_rot = legRotR;
  let kneeL_rot = 0, kneeR_rot = 0;
  let armL_rot = armRotL, armR_rot = armRotR;
  let elbowL_rot = 0, elbowR_rot = 0;
  let torsoTilt = 0;
  let yExtra = 0;

  const cF = animState.crouchF;
  bodyScale *= (1 - cF * CROUCH_FACTOR);
  thighL_rot += cF * 0.45; thighR_rot += cF * 0.45;
  kneeL_rot  += cF * -0.55; kneeR_rot  += cF * -0.55;
  torsoTilt  += cF * 0.25;
  armL_rot   += cF * 0.30; armR_rot += cF * 0.30;

  // Sit layer — deeper fold than crouch: thighs fold up 90°, shins roughly
  // vertical, hips drop ~0.45 m. The blend is driven by sitF so standing up
  // is smooth (0.20 s critically-damped spring).
  const sF = animState.sitF;
  if (sF > 0.001) {
    // Scale the body modestly so the seated figure still reads as a person.
    bodyScale *= (1 - sF * 0.12);
    thighL_rot += sF * 1.00; thighR_rot += sF * 1.00;
    kneeL_rot  += sF * -1.10; kneeR_rot  += sF * -1.10;
    torsoTilt  += sF * 0.08;
    // Arms relax forward onto the knees (or lap).
    armL_rot   += sF * 0.45; armR_rot += sF * 0.45;
    elbowL_rot += sF * -0.4; elbowR_rot += sF * -0.4;
    // Hips drop so the feet stay on the floor with the thighs folded up.
    yExtra += sF * -0.45;
  }

  torsoTilt += animState.runFactor * 0.18;

  if (animState.jumpPhase === 'anticipate') {
    const t = animState.jumpT;
    const tSm = t * t * (3 - 2 * t);
    bodyScale *= (1 - 0.18 * tSm);
    thighL_rot += 0.35 * tSm; thighR_rot += 0.35 * tSm;
    kneeL_rot  += -0.45 * tSm; kneeR_rot  += -0.45 * tSm;
    armL_rot   += -0.6 * tSm; armR_rot += -0.6 * tSm;
    yExtra += -0.09 * tSm;
  }
  if (animState.jumpPhase === 'airborne') {
    const blend = Math.min(1, animState.jumpT / 0.08);
    armL_rot   += 0.9 * blend; armR_rot += 0.9 * blend;
    elbowL_rot += -0.3 * blend; elbowR_rot += -0.3 * blend;
    thighL_rot += (0.5 + 0.15) * blend;
    thighR_rot += (0.5 - 0.15) * blend;
    kneeL_rot  += -0.6 * blend; kneeR_rot  += -0.6 * blend;
    torsoTilt  += 0.12 * blend;
  }
  if (animState.jumpPhase === 'landing') {
    const t = animState.jumpT, peakT = 0.18;
    const strength = animState.landingAmount * (t < peakT
      ? (t / peakT)
      : Math.pow(1 - (t - peakT) / (1 - peakT), 2));
    bodyScale *= (1 - 0.22 * strength);
    thighL_rot += 0.55 * strength; thighR_rot += 0.55 * strength;
    kneeL_rot  += -0.65 * strength; kneeR_rot  += -0.65 * strength;
    torsoTilt  += 0.08 * strength;
    yExtra += -0.14 * strength;
  }

  const eyeHeight = AVATAR_EYE_HEIGHT * bodyScale;

  // --- Apply to avatar parts ---
  // Position Y offset (bob + yExtra) layered on top of the controller's
  // collision-resolved position. Controller already copied pos into
  // character.position; we add the small cosmetic offset here.
  avatar.position.y = tpController.pos.y + bob + yExtra;
  avatar.scale.y = bodyScale;
  // Spine carries upper-body tilt + lean so torso + head + arms all move
  // together. Order YXZ: Y first (no-op here), then X (pitch forward), then
  // Z (roll for turn-lean) — in spine-local frame after the yaw on root.
  if (avatarParts?.spine) {
    avatarParts.spine.rotation.order = 'YXZ';
    avatarParts.spine.rotation.set(torsoTilt, 0, animState.turnLean);
  }
  if (avatarParts?.legL) {
    avatarParts.legL.rotation.x = thighL_rot;
    if (avatarParts.legL.userData.knee) avatarParts.legL.userData.knee.rotation.x = kneeL_rot;
  }
  if (avatarParts?.legR) {
    avatarParts.legR.rotation.x = thighR_rot;
    if (avatarParts.legR.userData.knee) avatarParts.legR.userData.knee.rotation.x = kneeR_rot;
  }
  if (avatarParts?.armL) {
    avatarParts.armL.rotation.x = armL_rot;
    if (avatarParts.armL.userData.elbow) avatarParts.armL.userData.elbow.rotation.x = elbowL_rot;
  }
  if (avatarParts?.armR) {
    avatarParts.armR.rotation.x = armR_rot;
    if (avatarParts.armR.userData.elbow) avatarParts.armR.userData.elbow.rotation.x = elbowR_rot;
  }

  // --- Live SPL readout ---
  if (walkSplOverlay) updateWalkSplReadout(ctx, eyeHeight);

  // Reset key — edge-trigger would be cleaner but this is idempotent.
  if (ctx.keys.has('KeyR')) {
    placeAvatarAtDefault();
    ctx.keys.delete('KeyR');
  }
}

// SPL readout overlay — shared between the rigged and procedural paths.
// Samples the current multi-source SPL at the avatar's ear and updates the
// top-right HTML overlay with the dB value, ear height, pose, and XYZ.
function updateWalkSplReadout(ctx, eyeHeight) {
  const px = tpController.pos.x;
  const py = tpController.pos.z;
  const pz = tpController.pos.y + eyeHeight;
  const listenerPos = { x: px, y: py, z: pz };
  const flat = expandSources(state.sources);
  const spl = flat.length > 0
    ? computeMultiSourceSPL({
        sources: flat,
        getSpeakerDef: url => getCachedLoudspeaker(url),
        listenerPos, room: state.room,
        ...currentPhysicsOpts(state.room),
      })
    : NaN;
  walkSplOverlay.querySelector('.walk-spl-big').textContent = isFinite(spl) ? spl.toFixed(1) + ' dB' : '— dB';

  // STIPA — computed throttled (~4 Hz) since it's 7-band work; cheaper than
  // the 1 kHz SPL sample but adds up if every frame.
  const now = performance.now();
  if (flat.length > 0 && materialsRef && (!_stipaLastTs || now - _stipaLastTs > 250)) {
    _stipaLastTs = now;
    const s = computeSTIPA({
      sources: flat,
      getSpeakerDef: url => getCachedLoudspeaker(url),
      listenerPos, room: state.room, materials: materialsRef,
      zones: state.zones,
      ambientNoise_per_band: state.physics.ambientNoise?.per_band,
    });
    _stipaLast = s;
  }
  const stiEl = walkSplOverlay.querySelector('[data-f="sti"]');
  if (stiEl) {
    if (_stipaLast) {
      stiEl.textContent = _stipaLast.sti.toFixed(2) + ' (' + _stipaLast.rating + ')';
      stiEl.className = 'walk-spl-val sti-' + _stipaLast.rating;
    } else {
      stiEl.textContent = '—';
    }
  }

  const earVal = walkSplOverlay.querySelector('[data-f="ear"]');
  const poseVal = walkSplOverlay.querySelector('[data-f="pose"]');
  const xyzVal = walkSplOverlay.querySelector('[data-f="xyz"]');
  if (earVal) earVal.textContent = eyeHeight.toFixed(2) + ' m';
  if (poseVal) {
    poseVal.textContent = !ctx.grounded
      ? 'jumping'
      : (animState.sitF > 0.5 ? 'sitting'
         : (animState.crouchF > 0.5 ? 'crouching' : 'standing'));
  }
  if (xyzVal) xyzVal.textContent = px.toFixed(1) + ' · ' + py.toFixed(1) + ' · ' + pz.toFixed(2);
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

// Seated-audience crowd — occupancy_percent on a zone drives both acoustic
// absorption (RT60 module) and visible people here. ~1.25 persons/m² at 100%
// occupancy (0.8 m²/seat, typical arena row spacing). Random shirt color per
// instance so the user can see the crowd as a visual cue.
const AUDIENCE_SHIRT_COLORS = [
  0xe63946, 0xf4a261, 0xe9c46a, 0x2a9d8f, 0x264653,
  0x9b5de5, 0x00bbf9, 0xfee440, 0xf28482, 0x84a98c,
  0x606c38, 0x8338ec, 0xff006e, 0x3a86ff, 0xfb5607,
  0x06a77d, 0xd90429, 0xffb703, 0x6a4c93, 0x219ebc,
];
const AUDIENCE_SKIN_COLORS = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524];
const AUDIENCE_DENSITY_PER_M2 = 1.25;
const AUDIENCE_GLOBAL_CAP = 8000;

function pointInZonePolygon(x, y, verts) {
  let inside = false;
  const n = verts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = verts[i].y, yj = verts[j].y;
    if ((yi > y) !== (yj > y)) {
      const xAtY = (verts[j].x - verts[i].x) * (y - yi) / (yj - yi) + verts[i].x;
      if (x < xAtY) inside = !inside;
    }
  }
  return inside;
}

function zonePolygonArea2D(verts) {
  let a = 0;
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += verts[i].x * verts[j].y - verts[j].x * verts[i].y;
  }
  return Math.abs(a) / 2;
}

// Box-Muller unit normal (mean 0, stddev 1). Cached-free; called a few hundred
// times per rebuild so performance is a non-issue.
function gaussianStd() {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Pose-specific audience geometry. Standing: 1.70 m total (body 1.40 + head
// centre 1.58, r=0.12). Seated: 1.24 m total from zone surface (torso 1.00
// starting at feet, head centre 1.12, r=0.12) — approximates a person on an
// arena tier where the seat plate is effectively the zone elevation.
function ensureAudienceGeo(pose) {
  if (audienceGeoCache[pose]) return audienceGeoCache[pose];
  if (pose === 'sitting') {
    const body = new THREE.BoxGeometry(0.42, 1.00, 0.30);
    body.translate(0, 0.50, 0);
    const head = new THREE.SphereGeometry(0.12, 10, 8);
    head.translate(0, 1.12, 0);
    audienceGeoCache[pose] = { body, head, ref: 1.24 };
  } else {
    const body = new THREE.BoxGeometry(0.42, 1.40, 0.28);
    body.translate(0, 0.70, 0);
    const head = new THREE.SphereGeometry(0.12, 10, 8);
    head.translate(0, 1.58, 0);
    audienceGeoCache[pose] = { body, head, ref: 1.70 };
  }
  return audienceGeoCache[pose];
}

function rebuildAudience() {
  if (!audienceGroup) {
    audienceGroup = new THREE.Group();
    scene.add(audienceGroup);
  } else {
    disposeGroup(audienceGroup);
  }
  if (!state.zones || state.zones.length === 0) return;

  // Plan total count per zone; scale down if we'd exceed the global cap so
  // huge stadium presets don't push 10k+ instances.
  const plans = [];
  let total = 0;
  for (const zone of state.zones) {
    const occFrac = Math.max(0, Math.min(1, (zone.occupancy_percent ?? 0) / 100));
    if (occFrac <= 0.01) continue;
    if (!zone.vertices || zone.vertices.length < 3) continue;
    const area = zonePolygonArea2D(zone.vertices);
    if (area <= 0) continue;
    const count = Math.max(1, Math.round(area * occFrac * AUDIENCE_DENSITY_PER_M2));
    plans.push({ zone, area, count });
    total += count;
  }
  if (total === 0) return;
  const scale = total > AUDIENCE_GLOBAL_CAP ? AUDIENCE_GLOBAL_CAP / total : 1;

  // Pose: seated figures for tiered stadium rooms, standing figures everywhere
  // else (shopping mall, pavilion concourse, shoebox). Standing reference is
  // 1.70 m; seated is ~1.24 m from zone surface (seated-on-tier sitting height).
  // Per-instance uniform scale adds a Gaussian height spread so the crowd
  // reads as mixed-height humans, not uniform clones.
  const pose = state.room?.stadiumStructure ? 'sitting' : 'standing';
  const geo = ensureAudienceGeo(pose);
  const audienceBodyGeo = geo.body;
  const audienceHeadGeo = geo.head;
  const heightJitterStd = pose === 'sitting' ? 0.04 : 0.055;
  const heightJitterClamp = pose === 'sitting' ? 0.08 : 0.12;

  const placements = [];
  for (const plan of plans) {
    const zone = plan.zone;
    const n = Math.max(1, Math.round(plan.count * scale));
    const xs = zone.vertices.map(v => v.x);
    const ys = zone.vertices.map(v => v.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const baseY = (zone.elevation_m ?? 0) + 0.05;
    let placed = 0, tries = 0;
    const maxTries = n * 25;
    while (placed < n && tries < maxTries) {
      tries++;
      const px = minX + Math.random() * (maxX - minX);
      const py = minY + Math.random() * (maxY - minY);
      if (!pointInZonePolygon(px, py, zone.vertices)) continue;
      placements.push({
        x: px, y: baseY, z: py,
        shirt: AUDIENCE_SHIRT_COLORS[Math.floor(Math.random() * AUDIENCE_SHIRT_COLORS.length)],
        skin:  AUDIENCE_SKIN_COLORS[Math.floor(Math.random() * AUDIENCE_SKIN_COLORS.length)],
        yaw: Math.random() * Math.PI * 2,
      });
      placed++;
    }
  }
  if (placements.length === 0) return;

  const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  const headMat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 });
  const bodyMesh = new THREE.InstancedMesh(audienceBodyGeo, bodyMat, placements.length);
  const headMesh = new THREE.InstancedMesh(audienceHeadGeo, headMat, placements.length);
  bodyMesh.castShadow = false;
  bodyMesh.receiveShadow = false;
  headMesh.castShadow = false;
  headMesh.receiveShadow = false;
  bodyMesh.userData.tag = 'audience_body';
  headMesh.userData.tag = 'audience_head';

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sv = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    pos.set(p.x, p.y, p.z);
    q.setFromAxisAngle(up, p.yaw);
    const dh = Math.max(-heightJitterClamp, Math.min(heightJitterClamp, gaussianStd() * heightJitterStd));
    const s = 1 + dh;
    sv.set(s, s, s);
    m.compose(pos, q, sv);
    bodyMesh.setMatrixAt(i, m);
    headMesh.setMatrixAt(i, m);
    col.setHex(p.shirt); bodyMesh.setColorAt(i, col);
    col.setHex(p.skin);  headMesh.setColorAt(i, col);
  }
  bodyMesh.instanceMatrix.needsUpdate = true;
  headMesh.instanceMatrix.needsUpdate = true;
  if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
  if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;

  audienceGroup.add(bodyMesh);
  audienceGroup.add(headMesh);
}

function colorForAlpha(alpha) {
  if (alpha < 0.10) return 0xd93a3a;
  if (alpha < 0.25) return 0xe6a53a;
  if (alpha < 0.45) return 0xd9c93a;
  if (alpha < 0.65) return 0x7fb85a;
  return 0x3a9e5a;
}

// 2D THREE.Shape in state coords, centred on origin. `flipY` lets the
// caller pick the right sign for whichever rotation the resulting mesh
// will use:
//
//   floor uses rotation.x = -π/2  (normal +Y; local Y → world -Z) → flipY = true
//   ceiling uses rotation.x = +π/2 (normal -Y; local Y → world +Z) → flipY = false
//
// The same `planShape` was previously used for BOTH floor and ceiling,
// which works for symmetric polygons (rectangle, regular polygon) but
// for irregular shapes (user-drawn triangle, L-shape) the ceiling
// renders mirrored along the Y axis vs the floor, so walls match the
// floor outline but the ceiling sits on the wrong side. Caught when
// the user reported a triangular custom room with walls + ceiling
// "not aligned properly".
function makeFloorCeilingShape(room, flipY = true) {
  const verts = roomPlanVertices(room);
  const cx = room.width_m / 2, cy = room.depth_m / 2;
  const ySign = flipY ? -1 : 1;
  const shape = new THREE.Shape();
  shape.moveTo(verts[0].x - cx, ySign * (verts[0].y - cy));
  for (let i = 1; i < verts.length; i++) {
    shape.lineTo(verts[i].x - cx, ySign * (verts[i].y - cy));
  }
  shape.closePath();
  return shape;
}

function rebuildRoom(isFirst) { shadowsNeedRefresh = true;
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

  // Wall slots may now be either string (legacy) or { materialId, openings }
  // (PR2). Normalise here so downstream PlaneGeometry/cylinder code keeps
  // a plain material-id string. Polygon / round shapes share a single
  // 'walls' slot that the panel doesn't expose openings on; the normaliser
  // ignores any openings that snuck in via a JSON edit so nothing breaks.
  const wallsMatId = normalizeWallSlot(
    surfaces.walls ?? surfaces.wall_north,
    'gypsum-board',
  ).materialId;

  // Each surface gets its own textured MeshStandardMaterial. Texture tiling
  // is computed from the surface's real-world dimensions so planks, tiles,
  // and bricks read at correct scale regardless of room size. Walls/ceiling
  // stay slightly translucent so the user can still see the interior from
  // outside; the floor is nearly opaque.
  const buildSurfaceMat = (materialId, widthM, heightM, { opacity = 0.6, doubleSide = true } = {}) => {
    // 'open-air' is a synthetic boundary material (α = 1.0) used when the
    // user marks a wall as open / no enclosure. Render as fully transparent
    // — the room's wireframe outlines mark where the wall used to be.
    // Mesh stays in the scene at opacity 0 so it's still raycastable: the
    // user can click the empty boundary in 3D to switch the wall back to a
    // solid material via the surface-picker pulse in the side panel.
    if (materialId === 'open-air') {
      return new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
        depthWrite: false,
        depthTest: false,
      });
    }
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
  const floorMat = buildSurfaceMat(surfaces.floor, w, d, { opacity: 0.95 });
  const ceilMat  = buildSurfaceMat(surfaces.ceiling, w, d, { opacity: 0.55 });
  const wallsMat = buildSurfaceMat(wallsMatId, (w + d), h, { opacity: 0.55 });

  // PR2: walls can carry doors / windows. When the wall slot is an object
  // with a non-empty openings[], cut rectangular holes out of the wall
  // mesh (ShapeGeometry) and render each opening as its own child mesh
  // at the hole's position with the opening's material. State === 'open'
  // resolves to the open-air material (invisible plane that still
  // raycasts) so the user can switch it back. UV is remapped to [0,1] over
  // the wall's bbox so buildSurfaceMat's per-meter tile density matches
  // the original PlaneGeometry walls.
  const buildWallGeoWithHoles = (ww, wh, openings) => {
    if (!openings || openings.length === 0) return new THREE.PlaneGeometry(ww, wh);
    const shape = new THREE.Shape();
    const hw = ww / 2, hh = wh / 2;
    shape.moveTo(-hw, -hh);
    shape.lineTo( hw, -hh);
    shape.lineTo( hw,  hh);
    shape.lineTo(-hw,  hh);
    shape.lineTo(-hw, -hh);
    for (const op of openings) {
      const ow = Number(op?.width_m), oh = Number(op?.height_m);
      if (!Number.isFinite(ow) || !Number.isFinite(oh) || ow <= 0 || oh <= 0) continue;
      const ox = Number(op.x_m) || 0, oz = Number(op.z_m) || 0;
      const x0 = ox - hw, y0 = oz - hh;
      const hole = new THREE.Path();
      hole.moveTo(x0,      y0);
      hole.lineTo(x0 + ow, y0);
      hole.lineTo(x0 + ow, y0 + oh);
      hole.lineTo(x0,      y0 + oh);
      hole.lineTo(x0,      y0);
      shape.holes.push(hole);
    }
    const geo = new THREE.ShapeGeometry(shape);
    const pos = geo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2]     = (pos.getX(i) + hw) / ww;
      uv[i * 2 + 1] = (pos.getY(i) + hh) / wh;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return geo;
  };

  // Build + attach an opening child mesh to its parent wall. Local-space
  // position centres the opening on its (x_m + w/2, z_m + h/2) wall-local
  // coords, with a 1 mm forward offset so its quad doesn't z-fight with
  // the hole's edges in the parent wall mesh.
  //
  // SYSTEM merge_cut openings (auto-generated by break-to-merge to mark
  // the overlap rectangle on a wall) do NOT get a child mesh: the wall
  // already has the hole punched in its ShapeGeometry, and the canonical
  // shared wall renders independently as a wallSegment. Without this
  // skip, the system-opening mesh would intercept surface-click rays at
  // the hole and route them to a panel row that doesn't exist (system
  // openings are filtered from the user-facing openings list), so the
  // click would silently fail and the merged wall couldn't be selected.
  const attachOpeningMesh = (wallMesh, op, ww, wh, opIdx, baseSurfaceId) => {
    if (op?.system) return;
    const ow = Number(op?.width_m), oh = Number(op?.height_m);
    if (!Number.isFinite(ow) || !Number.isFinite(oh) || ow <= 0 || oh <= 0) return;
    const isOpen = op?.state === 'open';
    const matId = isOpen ? 'open-air' : (op?.materialId || 'glass-window');
    const opGeo = new THREE.PlaneGeometry(ow, oh);
    const opMat = buildSurfaceMat(matId, ow, oh, { opacity: isOpen ? 0 : 0.85 });
    const opMesh = new THREE.Mesh(opGeo, opMat);
    const offsetX = (Number(op.x_m) || 0) + ow / 2 - ww / 2;
    const offsetY = (Number(op.z_m) || 0) + oh / 2 - wh / 2;
    opMesh.position.set(offsetX, offsetY, 0.001);
    opMesh.userData.tag = `opening_${op.kind || 'opening'}`;
    opMesh.userData.opening_id = op.id || `${baseSurfaceId}_op_${opIdx}`;
    opMesh.userData.acoustic_material = matId;
    opMesh.userData.surface_id = `${baseSurfaceId}_op_${opIdx}`;
    if (isOpen) opMesh.userData.no_walk_collide = true;   // open doors / windows are walk-through
    wallMesh.add(opMesh);
  };

  if (shape === 'rectangular') {
    // Floor + ceiling as rectangular planes
    const floorGeo = new THREE.PlaneGeometry(w, d);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0.001, cz);
    floor.userData.acoustic_material = surfaces.floor;
    floor.userData.surface_id = 'floor';
    roomGroup.add(floor);

    if (room.ceiling_type !== 'dome' && room.enclosure !== 'outdoor') {
      const ceilGeo = new THREE.PlaneGeometry(w, d);
      const ceiling = new THREE.Mesh(ceilGeo, ceilMat);
      ceiling.rotation.x = Math.PI / 2;
      ceiling.position.set(cx, h - 0.001, cz);
      ceiling.userData.acoustic_material = surfaces.ceiling;
      ceiling.userData.surface_id = 'ceiling';
      roomGroup.add(ceiling);
    }

    // 4 walls (per-material).
    const wallOpts = [
      // [ww, wh, pos, rot, slot, surfaceKey]
      [w, h, [cx, h/2, 0],   [0, Math.PI, 0],    surfaces.wall_north, 'wall_north'],
      [w, h, [cx, h/2, d],   [0, 0, 0],          surfaces.wall_south, 'wall_south'],
      [d, h, [w,  h/2, cz],  [0, -Math.PI/2, 0], surfaces.wall_east,  'wall_east'],
      [d, h, [0,  h/2, cz],  [0, Math.PI/2, 0],  surfaces.wall_west,  'wall_west'],
    ];
    for (const [ww, wh, pos, rot, slot, surfaceKey] of wallOpts) {
      const { materialId: surfId, openings } = normalizeWallSlot(slot);
      const geo = buildWallGeoWithHoles(ww, wh, openings);
      const mat = buildSurfaceMat(surfId, ww, wh, { opacity: 0.55 });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(...pos);
      m.rotation.set(...rot);
      m.userData.acoustic_material = surfId;
      m.userData.surface_id = surfaceKey;
      // Walk-mode collision flag — any wall whose material is "Open wall
      // (no boundary)" must NOT block the avatar. We set this explicitly
      // here so the third-person controller's collision filter has an
      // unambiguous signal independent of the material/opacity heuristics.
      if (surfId === 'open-air') m.userData.no_walk_collide = true;
      roomGroup.add(m);
      for (let oi = 0; oi < openings.length; oi++) {
        attachOpeningMesh(m, openings[oi], ww, wh, oi, surfaceKey);
      }
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
    // Polygon or round: use ShapeGeometry for floor/ceiling (plan shape).
    // Floor + ceiling need DIFFERENT shapes — see makeFloorCeilingShape
    // header. Floor's rotation.x = -π/2 maps local Y → world -Z (so the
    // shape Y must be flipped for state-Y to land at world +Z); ceiling's
    // rotation.x = +π/2 maps local Y → world +Z directly (no flip).
    const floorGeo = new THREE.ShapeGeometry(makeFloorCeilingShape(room, true));
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0.001, cz);
    floor.userData.acoustic_material = surfaces.floor;
    floor.userData.surface_id = 'floor';
    roomGroup.add(floor);

    if (room.ceiling_type !== 'dome' && room.enclosure !== 'outdoor') {
      const ceilGeo = new THREE.ShapeGeometry(makeFloorCeilingShape(room, false));
      const ceiling = new THREE.Mesh(ceilGeo, ceilMat);
      ceiling.rotation.x = Math.PI / 2;
      ceiling.position.set(cx, h - 0.001, cz);
      ceiling.userData.acoustic_material = surfaces.ceiling;
      ceiling.userData.surface_id = 'ceiling';
      roomGroup.add(ceiling);
    }

    if (shape === 'round') {
      // Cylindrical wall, open-ended. Uses its own material so texture
      // tiling matches the actual circumference (2πr) rather than the
      // rectangular-wall default.
      const r = room.round_radius_m ?? 3;
      const cylGeo = new THREE.CylinderGeometry(r, r, h, 48, 1, true);
      const cylMat = buildSurfaceMat(wallsMatId, 2 * Math.PI * r, h, { opacity: 0.55 });
      const cyl = new THREE.Mesh(cylGeo, cylMat);
      cyl.position.set(cx, h/2, cz);
      cyl.userData.acoustic_material = wallsMatId;
      cyl.userData.surface_id = 'walls';
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
      // Custom polygon: plane per edge, per-edge materials.
      //
      // Bug fix: the previous implementation used `m.lookAt(cx, h/2, cz)`
      // to point each wall toward the room centroid. That works for
      // regular polygons (centroid is perpendicular to every edge
      // midpoint by symmetry) but FAILS for irregular shapes — a user-
      // drawn triangle has edges where the centroid is NOT perpendicular
      // to the edge midpoint, so Three.js's auto-computed local X axis
      // (cross(up, localZ)) doesn't align with the edge direction.
      // Walls rotate around their centres and the corners stop meeting.
      //
      // Correct: build the rotation matrix manually, explicitly mapping
      // local X to the edge direction, local Y to world up, local Z to
      // the inward normal. Works for any convex (or concave) polygon.
      const verts = roomPlanVertices(room);
      const edges = room.surfaces.edges || [];
      const n = verts.length;
      const _basisX = new THREE.Vector3();
      const _basisY = new THREE.Vector3(0, 1, 0);
      const _basisZ = new THREE.Vector3();
      const _basisMat = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        const v1 = verts[i];
        const v2 = verts[(i + 1) % n];
        const ex = v2.x - v1.x, ey = v2.y - v1.y;
        const edgeLen = Math.sqrt(ex * ex + ey * ey);
        if (edgeLen < 0.01) continue;
        const midX = (v1.x + v2.x) / 2;
        const midZ = (v1.y + v2.y) / 2;
        const { materialId: edgeSurfId, openings } = normalizeWallSlot(edges[i]);
        const geo = buildWallGeoWithHoles(edgeLen, h, openings);
        const edgeMat = buildSurfaceMat(edgeSurfId, edgeLen, h, { opacity: 0.55 });
        const m = new THREE.Mesh(geo, edgeMat);

        // Edge direction in the floor (XZ) plane, normalised.
        let edgeDirX = ex / edgeLen;
        let edgeDirZ = ey / edgeLen;
        // 90° CCW rotation of edge direction → inward normal for a
        // CCW-wound polygon in state-Y-down coords. For a CW polygon
        // (e.g. user drew the triangle's second point with smaller Y
        // than the first), the same formula gives the OUTWARD normal.
        // We must flip BOTH the edge direction AND the normal so the
        // resulting basis (basisX × basisY = basisZ) stays right-handed
        // (determinant +1). Flipping ONLY the normal makes the basis
        // a reflection (det -1); Three.js's setFromRotationMatrix
        // returns garbage on reflections — that was the
        // direction-dependent misalignment bug.
        let nx = -edgeDirZ, nz = edgeDirX;
        const toCx = cx - midX, toCz = cz - midZ;
        if (nx * toCx + nz * toCz < 0) {
          edgeDirX = -edgeDirX;
          edgeDirZ = -edgeDirZ;
          nx = -nx;
          nz = -nz;
        }
        _basisX.set(edgeDirX, 0, edgeDirZ);
        _basisZ.set(nx, 0, nz);
        _basisMat.makeBasis(_basisX, _basisY, _basisZ);

        m.position.set(midX, h/2, midZ);
        m.quaternion.setFromRotationMatrix(_basisMat);
        m.userData.acoustic_material = edgeSurfId;
        m.userData.surface_id = `edge_${i}`;
        if (edgeSurfId === 'open-air') m.userData.no_walk_collide = true;
        roomGroup.add(m);
        for (let oi = 0; oi < openings.length; oi++) {
          attachOpeningMesh(m, openings[oi], edgeLen, h, oi, `edge_${i}`);
        }
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
        const segMat = buildSurfaceMat(wallsMatId, edgeLen, wallH, { opacity: 0.55 });
        const m = new THREE.Mesh(geo, segMat);
        const midY = (wallBottom + wallTop) / 2;
        m.position.set(midX, midY, midZ);
        m.lookAt(cx, midY, cz);
        m.userData.acoustic_material = wallsMatId;
        m.userData.surface_id = 'walls';
        m.userData.tag = inVom ? 'wall_above_tunnel' : 'wall';
        if (wallsMatId === 'open-air') m.userData.no_walk_collide = true;
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

  // Dome cap (any shape) — also skipped when outdoor (no roof at all).
  const dome = domeGeometry(room);
  if (dome && room.enclosure !== 'outdoor') {
    const { sphereRadius, rise, thetaMax } = dome;
    const capGeo = new THREE.SphereGeometry(sphereRadius, 48, 24, 0, Math.PI * 2, 0, thetaMax);
    const cap = new THREE.Mesh(capGeo, ceilMat);
    cap.position.set(cx, h + rise - sphereRadius, cz);
    cap.userData.acoustic_material = surfaces.ceiling;
    cap.userData.surface_id = 'ceiling';
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
  rebuildMultiLevelStructure(room);

  // Sub-structures (saved rooms placed into this room). Phase 1 = visual
  // only; the meshes go into roomGroup so aim raycasts terminate on them
  // and the heatmap probe / surface-click flow can hit them. Phase 2
  // (acoustic merging) lives next to this call — see header on
  // rebuildSubStructures.
  rebuildSubStructures(room);

  // Standalone enclosures (broken-out from a sub-structure into editable
  // walls). Phase 1: VISUAL ONLY — same Dr. Chen audit gate as
  // sub-structures. Walls/floor/ceiling render as proper textured meshes
  // with surface_id tags so the Room panel's click-to-pulse and material-
  // picker flows work the same way they do on parent walls. The hooks
  // we'd flip in Phase 2 — adding their surface-areas into roomSurfaces()
  // and accounting for transmission loss — live in physics/room-shape.js
  // (see roomSurfaces) NOT here. This function only deals with rendering.
  rebuildStandaloneEnclosures(room, {
    buildWallGeoWithHoles, attachOpeningMesh, buildSurfaceMat,
  });

  // Shared wall segments — produced by break-to-merge overlap split.
  // Each entry is an INDEPENDENT wall surface (not owned by any
  // polygon's edge ring). Phase 1: VISUAL ONLY — same Dr. Chen audit
  // gate as standaloneEnclosures and subStructures. Goes into roomGroup
  // so the aim raycaster picks it up automatically; click-pulse + hover
  // resolve via userData.surface_id = `wseg_${seg.id}` (matches the row
  // id set by renderSharedWallSegmentSection in panel-room.js).
  rebuildWallSegments(room, {
    buildWallGeoWithHoles, attachOpeningMesh, buildSurfaceMat,
  });

  if (isFirst) frameCameraToRoom();
}

// Render placed sub-structures (saved rooms imported into the parent
// room as visual elements). PHASE 1 — VISUAL ONLY: the sub-room walls,
// floor, ceiling render at the chosen offset/rotation and become aim-
// raycast targets, but they are NOT folded into roomSurfaces() for the
// RT60 / Hopkins-Stryker / STIPA math.
//
// PHASE 2 (DEFERRED, pending Dr. Chen review): acoustic merging. Each
// sub-room creates an interior compartment whose surfaces should add to
// the parent's total absorption budget (with a transmission-loss term
// for sound passing between parent and sub through any open boundary).
// Sabine + Eyring assume a single diffuse field, which is wrong the
// moment the room is partitioned — the next person here should NOT
// just sum surfaces; that overstates absorption and underestimates RT60.
// The right model is coupled-room reverberation (see e.g. Bradley & Wang
// 2009, "Sound fields in coupled rooms") which is the tracked Phase 2
// task on Dr. Chen's audit list.
//
// Each sub-structure renders in a child Group whose:
//   position = (sub.position.x_m, sub.elevation_m, sub.position.y_m)  [three coords]
//   rotation around the local Y axis = sub.rotation_deg
// The sub-room is built in its own LOCAL coordinate frame (origin at
// sub-room's bbox 0,0,0) so the parent transform places it correctly.
// Meshes carry userData.tag = 'sub_structure' so future code can filter
// them in/out of physics surface lists in one place.
function rebuildSubStructures(parentRoom, opts = {}) {
  if (!roomGroup) return;
  const { ghostOnly = false } = opts;
  const subs = Array.isArray(parentRoom.subStructures) ? parentRoom.subStructures : [];
  for (const sub of subs) {
    if (!sub || !sub.sourceRoom) continue;
    const g = buildSubStructureGroup(sub.sourceRoom, {
      ghost: ghostOnly,
      label: sub.sourceRoomName ?? 'Sub-room',
    });
    if (!g) continue;
    const px = sub.position?.x_m ?? 0;
    const py = sub.position?.y_m ?? 0;
    const elev = sub.elevation_m ?? 0;
    g.position.set(px, elev, py);
    g.rotation.y = ((sub.rotation_deg ?? 0) * Math.PI) / 180;
    g.userData.tag = 'sub_structure';
    g.userData.sub_id = sub.id;
    roomGroup.add(g);
  }
}

// Build a single sub-room as a child Group, in LOCAL coordinates. Caller
// places + rotates the group via group.position / group.rotation.y.
// Walls / floor / ceiling are simple LineSegments outlines + translucent
// fill so the sub-room reads as "ghost geometry" rather than fighting
// the parent's textured walls for visual attention. ghost=true (used by
// the placement preview controller) renders even more transparent +
// adds a coloured tint so the user knows it isn't committed yet.
function buildSubStructureGroup(sourceRoom, { ghost = false, label = 'Sub-room' } = {}) {
  if (!sourceRoom) return null;
  const w = sourceRoom.width_m ?? 5;
  const h = sourceRoom.height_m ?? 3;
  const d = sourceRoom.depth_m ?? 5;
  if (!(w > 0 && h > 0 && d > 0)) return null;
  const g = new THREE.Group();

  const fillColor = ghost ? 0x4aa3ff : 0xb6c2d6;
  const lineColor = ghost ? 0x7fc7ff : 0x8a93a3;
  const fillOpacity = ghost ? 0.18 : 0.22;

  const fillMat = new THREE.MeshBasicMaterial({
    color: fillColor,
    transparent: true,
    opacity: fillOpacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const lineMat = new THREE.LineBasicMaterial({
    color: lineColor,
    transparent: true,
    opacity: ghost ? 0.95 : 0.85,
  });

  // Floor
  const floorGeo = new THREE.PlaneGeometry(w, d);
  const floor = new THREE.Mesh(floorGeo, fillMat.clone());
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(w / 2, 0.01, d / 2);
  floor.userData.tag = 'sub_structure_surface';
  floor.userData.surface_id = 'floor';
  g.add(floor);

  // Ceiling (always a flat cap regardless of source ceiling_type — the
  // dome rise is a v2 nicety; for a placed hut a flat lid is enough to
  // visually communicate the volume).
  if (sourceRoom.enclosure !== 'outdoor') {
    const ceilGeo = new THREE.PlaneGeometry(w, d);
    const ceiling = new THREE.Mesh(ceilGeo, fillMat.clone());
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(w / 2, h - 0.01, d / 2);
    ceiling.userData.tag = 'sub_structure_surface';
    ceiling.userData.surface_id = 'ceiling';
    g.add(ceiling);
  }

  // Walls — choose between rectangular four-wall and custom-polygon
  // edges based on the source room shape. Polygon / round shapes fall
  // through to the bbox four-wall rendering as a simplification (the
  // sub-room geometry is already a snapshot, and the bbox fills the
  // same volume with negligible visual loss at the placement scale).
  const shape = sourceRoom.shape ?? 'rectangular';
  if (shape === 'custom' && Array.isArray(sourceRoom.custom_vertices) && sourceRoom.custom_vertices.length >= 3) {
    const verts = sourceRoom.custom_vertices;
    for (let i = 0; i < verts.length; i++) {
      const v1 = verts[i];
      const v2 = verts[(i + 1) % verts.length];
      const ex = v2.x - v1.x, ey = v2.y - v1.y;
      const len = Math.sqrt(ex * ex + ey * ey);
      if (len < 0.01) continue;
      const wallGeo = new THREE.PlaneGeometry(len, h);
      const wall = new THREE.Mesh(wallGeo, fillMat.clone());
      const midX = (v1.x + v2.x) / 2;
      const midZ = (v1.y + v2.y) / 2;
      wall.position.set(midX, h / 2, midZ);
      // Face the wall along the edge direction. The custom polygon
      // wall in the parent rebuildRoom uses a manual basis matrix; for
      // a sub-room ghost we can use lookAt against an inward point
      // (bbox centre), which is sufficient for visual indication.
      wall.lookAt(w / 2, h / 2, d / 2);
      wall.userData.tag = 'sub_structure_surface';
      wall.userData.surface_id = `edge_${i}`;
      g.add(wall);
    }
    // Outline rings.
    const bottom = verts.map(v => new THREE.Vector3(v.x, 0, v.y));
    bottom.push(bottom[0]);
    const top = verts.map(v => new THREE.Vector3(v.x, h, v.y));
    top.push(top[0]);
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(bottom), lineMat));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(top), lineMat));
    for (let i = 0; i < verts.length; i++) {
      const pts = [
        new THREE.Vector3(verts[i].x, 0, verts[i].y),
        new THREE.Vector3(verts[i].x, h, verts[i].y),
      ];
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    }
  } else {
    // 4 walls of the bbox
    const wallSpecs = [
      // [ww, wh, pos, rot]
      [w, h, [w / 2, h / 2, 0],   [0, Math.PI, 0]],
      [w, h, [w / 2, h / 2, d],   [0, 0, 0]],
      [d, h, [w,     h / 2, d / 2], [0, -Math.PI / 2, 0]],
      [d, h, [0,     h / 2, d / 2], [0,  Math.PI / 2, 0]],
    ];
    for (const [ww, wh, pos, rot] of wallSpecs) {
      const wg = new THREE.PlaneGeometry(ww, wh);
      const wall = new THREE.Mesh(wg, fillMat.clone());
      wall.position.set(...pos);
      wall.rotation.set(...rot);
      wall.userData.tag = 'sub_structure_surface';
      g.add(wall);
    }
    const box = new THREE.BoxGeometry(w, h, d);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), lineMat);
    edges.position.set(w / 2, h / 2, d / 2);
    g.add(edges);
    box.dispose();
  }

  return g;
}

// Render standalone enclosures — independent editable wall structures
// produced by Break-to-merge. PHASE 1: VISUAL ONLY (Dr. Chen audit
// gate). roomSurfaces() does NOT include these surfaces yet; coupled-
// room reverberation Phase 2 lives next to rebuildSubStructures' header.
//
// Each enclosure has:
//   polygon[]  — vertices in PARENT-state coords (transform already
//                baked from the source sub-structure's position+rotation
//                during break-to-merge in panel-room.js).
//   height_m   — wall height
//   elevation_m— floor offset above the parent's floor (kept for editing,
//                same convention as the source sub-structure).
//   surfaces   — { floor, ceiling, edges: [slot...] }
//
// Wall mesh tagging: surface_id = `enclosure_${i}_edge_${j}`, floor =
// `enclosure_${i}_floor`, ceiling = `enclosure_${i}_ceiling`. The
// existing surface-pulse + hover system reads userData.surface_id, so
// click-to-pulse from 3D into the per-enclosure section in panel-room.js
// is automatic.
//
// Wall builders (buildWallGeoWithHoles, attachOpeningMesh, buildSurfaceMat)
// are passed in from the caller because they're locals inside rebuildRoom
// where buildSurfaceMat closes over the loaded textures cache. Having the
// caller hand them down is cheaper than re-defining the builders here and
// keeps the wall geometry path identical to the parent's custom-edge code.
function rebuildStandaloneEnclosures(parentRoom, helpers = {}) {
  if (!roomGroup) return;
  const list = Array.isArray(parentRoom.standaloneEnclosures) ? parentRoom.standaloneEnclosures : [];
  if (list.length === 0) return;
  const { buildWallGeoWithHoles, attachOpeningMesh, buildSurfaceMat } = helpers;
  if (typeof buildWallGeoWithHoles !== 'function'
      || typeof attachOpeningMesh !== 'function'
      || typeof buildSurfaceMat !== 'function') return;

  const _basisX = new THREE.Vector3();
  const _basisY = new THREE.Vector3(0, 1, 0);
  const _basisZ = new THREE.Vector3();
  const _basisMat = new THREE.Matrix4();

  for (let ei = 0; ei < list.length; ei++) {
    const enc = list[ei];
    if (!enc || !Array.isArray(enc.polygon) || enc.polygon.length < 3) continue;
    const verts = enc.polygon;
    const h = Number.isFinite(enc.height_m) ? enc.height_m : 3;
    if (h <= 0) continue;
    const elev = Number.isFinite(enc.elevation_m) ? enc.elevation_m : 0;
    const surfaces = enc.surfaces || {};
    const edgeSlots = Array.isArray(surfaces.edges) ? surfaces.edges : [];

    // Bbox + centroid for centroid-relative inward-normal test (used to
    // pick the wall's outward face). For a degenerate self-intersecting
    // polygon the centroid may not be inside, but the flip-on-negative
    // dot heuristic still keeps the wall's local X aligned with the edge.
    let cx = 0, cz = 0;
    for (const v of verts) { cx += v.x; cz += v.y; }
    cx /= verts.length; cz /= verts.length;

    const group = new THREE.Group();
    group.userData.tag = 'standalone_enclosure';
    group.userData.enclosure_idx = ei;
    group.userData.enclosure_id = enc.id;
    // The polygon is already in parent coords — only elevation needs
    // applying (lift the whole enclosure off the floor).
    group.position.set(0, elev, 0);

    // Floor + ceiling shapes — the polygon is in state coords (state.y
    // maps to world.z). PlaneGeometry's local XY plane needs different
    // Y-sign treatment for floor vs ceiling because the two meshes
    // rotate opposite directions:
    //   floor.rotation.x = -π/2  → local Y maps to world -Z (needs flip)
    //   ceiling.rotation.x = +π/2 → local Y maps to world +Z (no flip)
    // Without the floor flip, the enclosure's floor mirrors across the
    // Z axis and appears at the wrong world position (the bug that caused
    // a stray floor square outside the parent room after break-to-merge).
    const floorShape = new THREE.Shape();
    floorShape.moveTo(verts[0].x, -verts[0].y);
    for (let i = 1; i < verts.length; i++) floorShape.lineTo(verts[i].x, -verts[i].y);
    floorShape.lineTo(verts[0].x, -verts[0].y);
    const ceilShape = new THREE.Shape();
    ceilShape.moveTo(verts[0].x, verts[0].y);
    for (let i = 1; i < verts.length; i++) ceilShape.lineTo(verts[i].x, verts[i].y);
    ceilShape.lineTo(verts[0].x, verts[0].y);

    // Floor — slight elevation bump (y = elev + 0.003) so when an
    // enclosure overlaps the parent's floor, this floor renders ON TOP
    // of the parent's. Parent floor sits at y=0.001; we use 0.003 (after
    // the group's elevation translate) so the visual layering is
    // unambiguous and matches the user's mental model: "the placed room
    // is master; what it covers is hidden."
    const floorMatId = surfaces.floor || 'wood-floor';
    const floorGeo = new THREE.ShapeGeometry(floorShape);
    const floorMat = buildSurfaceMat(floorMatId, 1, 1, { opacity: 0.95 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0.003, 0);
    floor.userData.acoustic_material = floorMatId;
    floor.userData.surface_id = `enclosure_${ei}_floor`;
    group.add(floor);

    // Ceiling — flat cap (dome rise is a Phase-2 nicety).
    const ceilMatId = surfaces.ceiling || 'gypsum-board';
    const ceilGeo = new THREE.ShapeGeometry(ceilShape);
    const ceilMat = buildSurfaceMat(ceilMatId, 1, 1, { opacity: 0.55 });
    const ceiling = new THREE.Mesh(ceilGeo, ceilMat);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, h - 0.002, 0);
    ceiling.userData.acoustic_material = ceilMatId;
    ceiling.userData.surface_id = `enclosure_${ei}_ceiling`;
    group.add(ceiling);

    // Walls — one per polygon edge, mirroring the parent's custom-edge
    // path so openings (doors / windows) work identically. Re-uses
    // buildWallGeoWithHoles + attachOpeningMesh + normalizeWallSlot.
    const n = verts.length;
    for (let i = 0; i < n; i++) {
      const v1 = verts[i];
      const v2 = verts[(i + 1) % n];
      const ex = v2.x - v1.x, ey = v2.y - v1.y;
      const edgeLen = Math.sqrt(ex * ex + ey * ey);
      if (edgeLen < 0.01) continue;
      const midX = (v1.x + v2.x) / 2;
      const midZ = (v1.y + v2.y) / 2;
      const { materialId: edgeSurfId, openings } = normalizeWallSlot(edgeSlots[i]);
      const geo = buildWallGeoWithHoles(edgeLen, h, openings);
      const edgeMat = buildSurfaceMat(edgeSurfId, edgeLen, h, { opacity: 0.55 });
      const m = new THREE.Mesh(geo, edgeMat);

      let edgeDirX = ex / edgeLen;
      let edgeDirZ = ey / edgeLen;
      let nx = -edgeDirZ, nz = edgeDirX;
      const toCx = cx - midX, toCz = cz - midZ;
      if (nx * toCx + nz * toCz < 0) {
        edgeDirX = -edgeDirX;
        edgeDirZ = -edgeDirZ;
        nx = -nx;
        nz = -nz;
      }
      _basisX.set(edgeDirX, 0, edgeDirZ);
      _basisZ.set(nx, 0, nz);
      _basisMat.makeBasis(_basisX, _basisY, _basisZ);

      m.position.set(midX, h / 2, midZ);
      m.quaternion.setFromRotationMatrix(_basisMat);
      m.userData.acoustic_material = edgeSurfId;
      m.userData.surface_id = `enclosure_${ei}_edge_${i}`;
      if (edgeSurfId === 'open-air') m.userData.no_walk_collide = true;
      group.add(m);
      for (let oi = 0; oi < openings.length; oi++) {
        attachOpeningMesh(m, openings[oi], edgeLen, h, oi, `enclosure_${ei}_edge_${i}`);
      }
    }

    // Wireframe rings + verticals so the enclosure outline reads against
    // a busy parent scene.
    const lineMat = new THREE.LineBasicMaterial({ color: 0xa0a8b4 });
    const bottomPts = verts.map(v => new THREE.Vector3(v.x, 0, v.y));
    bottomPts.push(bottomPts[0]);
    const topPts = verts.map(v => new THREE.Vector3(v.x, h, v.y));
    topPts.push(topPts[0]);
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(bottomPts), lineMat));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(topPts), lineMat));
    for (let i = 0; i < n; i++) {
      const pts = [
        new THREE.Vector3(verts[i].x, 0, verts[i].y),
        new THREE.Vector3(verts[i].x, h, verts[i].y),
      ];
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    }

    roomGroup.add(group);
  }
}

// Render shared wall segments — entries in state.room.wallSegments[]
// produced by the break-to-merge overlap split. Each segment is a
// standalone wall in PARENT-state coords with its own material slot
// + openings list. PHASE 1: VISUAL ONLY (Dr. Chen audit gate before
// any acoustic accounting). Phase 2 lives in physics/room-shape.js
// next to multi-level interior surfaces (NOT here — this function
// only deals with rendering).
//
// The outward normal flip is symmetric: a shared wall has no
// "inside" or "outside" — it sits between the parent room and the
// enclosure. Rendering uses DoubleSide so both faces are visible no
// matter which side the camera is on, and we pick an arbitrary
// (right-hand-rule consistent) basis. The userData.surface_id is
// `wseg_${seg.id}` so the click-pulse system in panel-room.js
// resolves the row by matching this id verbatim.
//
// Wall builders (buildWallGeoWithHoles, attachOpeningMesh,
// buildSurfaceMat) come in from rebuildRoom — same plumbing as
// rebuildStandaloneEnclosures, same reason (closes over textures).
function rebuildWallSegments(parentRoom, helpers = {}) {
  if (!roomGroup) return;
  const list = Array.isArray(parentRoom.wallSegments) ? parentRoom.wallSegments : [];
  if (list.length === 0) return;
  const { buildWallGeoWithHoles, attachOpeningMesh, buildSurfaceMat } = helpers;
  if (typeof buildWallGeoWithHoles !== 'function'
      || typeof attachOpeningMesh !== 'function'
      || typeof buildSurfaceMat !== 'function') return;

  const _basisX = new THREE.Vector3();
  const _basisY = new THREE.Vector3(0, 1, 0);
  const _basisZ = new THREE.Vector3();
  const _basisMat = new THREE.Matrix4();

  for (const seg of list) {
    if (!seg || typeof seg !== 'object') continue;
    const x1 = Number(seg.x1), y1 = Number(seg.y1);
    const x2 = Number(seg.x2), y2 = Number(seg.y2);
    if (!Number.isFinite(x1) || !Number.isFinite(y1)
        || !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
    const ex = x2 - x1, ey = y2 - y1;
    const edgeLen = Math.sqrt(ex * ex + ey * ey);
    if (edgeLen < 0.01) continue;
    const h = Number.isFinite(seg.height_m) ? seg.height_m : (parentRoom.height_m ?? 3);
    if (h <= 0) continue;
    const elev = Number.isFinite(seg.elevation_m) ? seg.elevation_m : 0;
    const matId = typeof seg.materialId === 'string' ? seg.materialId : 'gypsum-board';
    const openings = Array.isArray(seg.openings) ? seg.openings : [];

    const midX = (x1 + x2) / 2;
    const midZ = (y1 + y2) / 2;
    const edgeDirX = ex / edgeLen;
    const edgeDirZ = ey / edgeLen;
    // 90° CCW from edge direction in the floor (XZ) plane. There's no
    // "interior" reference for a shared wall, so pick this basis and
    // rely on DoubleSide rendering for both faces to stay visible.
    const nx = -edgeDirZ, nz = edgeDirX;
    _basisX.set(edgeDirX, 0, edgeDirZ);
    _basisZ.set(nx, 0, nz);
    _basisMat.makeBasis(_basisX, _basisY, _basisZ);

    // Offset 1 cm along the wall normal so the wallSegment is NOT
    // coincident with the parent wall (or another enclosure wall) sharing
    // the same plane. Coincident planes give Three.js's raycaster a
    // non-deterministic tie-break — the wallSegment was losing the tie,
    // so clicking the merged region pulsed the parent's hole-edge instead
    // (which has no panel row → silent failure). 1 cm is below visual-
    // perception threshold at any reasonable camera distance and stops
    // the z-fight cleanly.
    const NORMAL_OFFSET_M = 0.01;
    const geo = buildWallGeoWithHoles(edgeLen, h, openings);
    const wallMat = buildSurfaceMat(matId, edgeLen, h, { opacity: 0.55 });
    const m = new THREE.Mesh(geo, wallMat);
    m.position.set(
      midX + nx * NORMAL_OFFSET_M,
      elev + h / 2,
      midZ + nz * NORMAL_OFFSET_M,
    );
    m.quaternion.setFromRotationMatrix(_basisMat);
    m.userData.acoustic_material = matId;
    m.userData.surface_id = `wseg_${seg.id}`;
    m.userData.tag = 'wall_segment';
    if (matId === 'open-air') m.userData.no_walk_collide = true;
    roomGroup.add(m);
    for (let oi = 0; oi < openings.length; oi++) {
      attachOpeningMesh(m, openings[oi], edgeLen, h, oi, `wseg_${seg.id}`);
    }
  }
}

// Module-level placement-preview group + controller plumbing. The Place-
// Room controller (js/graphics/place-room-controller.js) renders a ghost
// of the source sub-room while the user moves it, then commits via
// state.room.subStructures push + room:changed event for the real
// rebuild path. Keeping the ghost separate from roomGroup lets us update
// it 60 fps without tearing down + rebuilding the entire room.
let placementGhostGroup = null;
let placementGhostInfo = null; // { sourceRoom, sourceRoomName }

function clearPlacementGhost() {
  if (placementGhostGroup) {
    disposeGroup(placementGhostGroup);
    placementGhostGroup.parent?.remove(placementGhostGroup);
    placementGhostGroup = null;
  }
  placementGhostInfo = null;
}

function setPlacementGhost(sourceRoom, sourceRoomName, transform) {
  if (!scene) return;
  if (!placementGhostGroup || placementGhostInfo?.sourceRoom !== sourceRoom) {
    clearPlacementGhost();
    const g = buildSubStructureGroup(sourceRoom, { ghost: true, label: sourceRoomName });
    if (!g) return;
    g.userData.tag = 'sub_structure_ghost';
    placementGhostGroup = g;
    placementGhostInfo = { sourceRoom, sourceRoomName };
    scene.add(g);
  }
  if (transform) {
    placementGhostGroup.position.set(
      transform.position.x_m,
      transform.elevation_m,
      transform.position.y_m,
    );
    placementGhostGroup.rotation.y = ((transform.rotation_deg ?? 0) * Math.PI) / 180;
  }
}

// Public API for the placement controller. Returns the renderer DOM
// element + camera + scene refs the controller needs to attach mouse
// events and screen-to-world raycasts. Returns null until the 3D viewport
// has finished mounting.
//
// setOrbitEnabled — placement mode disables OrbitControls so dragging
// the cursor doesn't pan/rotate the camera at the same time as moving
// the ghost. Caller flips it off before enabling, on after disposing.
export function getPlacementBindings() {
  if (!camera || !renderer || !scene) return null;
  return {
    domElement: renderer.domElement,
    camera,
    scene,
    setGhost: setPlacementGhost,
    clearGhost: clearPlacementGhost,
    setOrbitEnabled: (on) => { if (controls) controls.enabled = !!on; },
  };
}

// Fit the orbit camera to whatever's in state.room so a preset / template
// swap, or a project-file load, lands the user looking at the new room
// from a sensible distance. Without this, switching from a 60-m arena to
// a 4.5-m hi-fi leaves the camera still 80 m back — the room appears as
// a tiny dot until the user manually zooms in. Symmetric fail in the
// other direction. Called on `scene:reset`, NOT on `room:changed` —
// dragging a width slider should not jump the camera every tick.
// Also bound to the F shortcut so the user can re-fit after manual
// dimension edits or a misadventure with the orbit drag.
export function frameCameraToRoom() {
  if (!camera || !controls) return;
  const room = state.room;
  const w = room.width_m ?? 10;
  const h = room.height_m ?? 3;
  const d = room.depth_m ?? 10;
  const cx = w / 2;
  const cz = d / 2;
  const d3 = Math.max(w, h, d);
  camera.position.set(cx + d3 * 0.9, h + d3 * 0.5, d + d3 * 0.4);
  controls.target.set(cx, h * 0.4, cz);
  controls.update();
}

// Smooth-focus tween — set when listener:selected fires (and we're in
// 3D view, not walk mode). Each frame _tickCameraFocus eases controls
// .target + camera.position toward the targets until both are within
// epsilon, then clears the tween.
let _focusTween = null;       // { targetPos: Vec3, targetCam: Vec3, t0, durationMs }
const _focusTmp = new THREE.Vector3();

export function focusCameraOnSelectedListener() {
  if (walkMode || !camera || !controls) return;
  const lst = getSelectedListener();
  if (!lst) return;
  // State coords (x=width, y=depth, z=elevation) → Three.js (x, z=elevation+ear, y=depth).
  const earHeight = 1.2;     // typical seated ear, matches receiver sphere centre
  const tx = lst.position.x;
  const ty = (lst.elevation_m ?? 0) + earHeight;
  const tz = lst.position.y;
  // Pull the camera toward a sensible orbiting offset. Keep current
  // distance + altitude bias roughly the same so the user doesn't lose
  // their bearings. If camera is closer than 2 m, push out; if further
  // than 12 m, pull in.
  const currentDist = camera.position.distanceTo(controls.target);
  const dist = Math.min(12, Math.max(3, currentDist));
  // Direction from current target → current camera, reused so the new
  // framing keeps roughly the same angle.
  _focusTmp.copy(camera.position).sub(controls.target);
  if (_focusTmp.lengthSq() < 0.01) {
    // Camera was sitting on the target — pick a default 3/4 view.
    _focusTmp.set(dist * 0.7, dist * 0.5, dist * 0.7);
  } else {
    _focusTmp.normalize().multiplyScalar(dist);
  }
  _focusTween = {
    targetPos: new THREE.Vector3(tx, ty, tz),
    targetCam: new THREE.Vector3(tx + _focusTmp.x, ty + _focusTmp.y, tz + _focusTmp.z),
    startPos: controls.target.clone(),
    startCam: camera.position.clone(),
    t0: performance.now(),
    durationMs: 600,
  };
}

function _tickCameraFocus(ts) {
  if (!_focusTween || !controls || !camera) return;
  const t = Math.min(1, ((ts || performance.now()) - _focusTween.t0) / _focusTween.durationMs);
  const e = t * t * (3 - 2 * t);  // smoothstep ease
  controls.target.lerpVectors(_focusTween.startPos, _focusTween.targetPos, e);
  camera.position.lerpVectors(_focusTween.startCam, _focusTween.targetCam, e);
  if (t >= 1) _focusTween = null;
}

// ----- AutoCAD-style preset views ----------------------------------------
// Six buttons (Top / Front / Back / Left / Right / Iso) anchored to the
// top-right of the 3D viewport. Each preset frames the entire room AABB
// (any shape) using FOV-derived distance math: we project the AABB onto
// the camera plane and pull back far enough that both axes fit, with a
// 1.15× margin. Tween hooks the existing _focusTween system so the
// transition is smooth (~500 ms) rather than an instant snap.
//
// AABB sourcing — roomEffectiveBounds() already unions the parent
// footprint with every standaloneEnclosure polygon, so the framing
// stays correct for detached zones and arbitrary polygons. Falls back
// to width_m / depth_m for the degenerate / boot-time case where the
// vertex list is empty (e.g. mid-draw custom polygon).
//
// Axis mapping (state → three.js): state.x → world.x, state.y → world.z,
// elevation → world.y. Room sits with min corner at (0,0,0).
function _roomWorldAABB() {
  const room = state.room || {};
  const h = room.height_m ?? 3;
  let b = null;
  try { b = roomEffectiveBounds(room); } catch (_) { b = null; }
  let minX, maxX, minZ, maxZ;
  if (b && Number.isFinite(b.minX) && Number.isFinite(b.maxX) && b.maxX > b.minX) {
    minX = b.minX; maxX = b.maxX; minZ = b.minY; maxZ = b.maxY;
  } else {
    minX = 0; maxX = room.width_m ?? 10;
    minZ = 0; maxZ = room.depth_m ?? 10;
  }
  const w = maxX - minX;
  const d = maxZ - minZ;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const cy = h * 0.4;             // matches frameCameraToRoom target altitude
  return { minX, maxX, minZ, maxZ, w, d, h, cx, cy, cz };
}

// Distance that frames an extentX × extentY rectangle filling the camera
// frustum, given the current camera's vertical FOV and aspect ratio.
// margin > 1 leaves breathing room around the edges.
function _fitDistance(extentX, extentY, margin) {
  if (!camera) return 10;
  const fovV = THREE.MathUtils.degToRad(camera.fov || 38);
  const aspect = Math.max(camera.aspect || 1, 0.1);
  // distance so extentY fits vertically
  const distY = (extentY / 2) / Math.tan(fovV / 2);
  // distance so extentX fits horizontally (horizontal fov derived from V)
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * aspect);
  const distX = (extentX / 2) / Math.tan(fovH / 2);
  return Math.max(distX, distY) * (margin || 1.15);
}

// Build (targetPos, targetCam) for a named preset. Returns null if the
// preset name is unknown or the room AABB is degenerate.
function _cameraPresetTransform(name) {
  if (!camera) return null;
  const aabb = _roomWorldAABB();
  const { minX, maxX, minZ, maxZ, w, d, h, cx, cy, cz } = aabb;
  // Small safety floor — frames don't collapse onto a zero-extent axis.
  const safe = (v) => Math.max(v, 0.5);
  switch (name) {
    case 'top': {
      // Looking straight down. extentX = w, extentY = d. Lift the camera
      // high enough that w AND d fit, then put target at floor centre
      // with a tiny +z offset so OrbitControls' polar axis doesn't sing
      // gimbal lock when the camera is exactly above target.
      const dist = _fitDistance(safe(w), safe(d), 1.20);
      const camY = dist + h;       // above the room ceiling, by dist
      // Camera looks toward +Z so that state +y (depth) maps to screen
      // DOWN — matches the 2D plan orientation (front wall at top of
      // screen, back wall at bottom). Achieved by offsetting the target
      // very slightly in -z relative to camera xz so up-vector resolves.
      return {
        targetPos: new THREE.Vector3(cx, 0, cz + 0.001),
        targetCam: new THREE.Vector3(cx, camY, cz),
      };
    }
    case 'front': {
      // Viewed from the FRONT wall (state.y = 0 → world.z = 0). Camera
      // sits outside that wall looking toward +Z. extentX = w, extentY = h.
      const dist = _fitDistance(safe(w), safe(h), 1.20);
      return {
        targetPos: new THREE.Vector3(cx, h * 0.5, cz),
        targetCam: new THREE.Vector3(cx, h * 0.5, minZ - dist),
      };
    }
    case 'back': {
      // Viewed from the BACK wall (state.y = maxY) looking toward -Z.
      const dist = _fitDistance(safe(w), safe(h), 1.20);
      return {
        targetPos: new THREE.Vector3(cx, h * 0.5, cz),
        targetCam: new THREE.Vector3(cx, h * 0.5, maxZ + dist),
      };
    }
    case 'left': {
      // Viewed from the LEFT wall (state.x = 0) looking toward +X.
      // extentX (screen-horizontal) = d (room depth), extentY = h.
      const dist = _fitDistance(safe(d), safe(h), 1.20);
      return {
        targetPos: new THREE.Vector3(cx, h * 0.5, cz),
        targetCam: new THREE.Vector3(minX - dist, h * 0.5, cz),
      };
    }
    case 'right': {
      // Viewed from the RIGHT wall (state.x = maxX) looking toward -X.
      const dist = _fitDistance(safe(d), safe(h), 1.20);
      return {
        targetPos: new THREE.Vector3(cx, h * 0.5, cz),
        targetCam: new THREE.Vector3(maxX + dist, h * 0.5, cz),
      };
    }
    case 'iso':
    default: {
      // Iterative perspective "frame selected" fit. Three prior
      // attempts (fixed multiplier, bounding-sphere, AABB-corner
      // tangent fit) all clipped. Root cause: each one solved for an
      // ABSTRACT AABB at the TARGET depth — but the binding corner
      // sits CLOSER to the camera than the target, so its on-screen
      // extent is larger than tan(fov/2) × dist predicts. Perspective
      // foreshortening makes a closer corner LOOK bigger than a far
      // corner of equal world extent, so the closer corner is what
      // clips first.
      //
      // Correct algorithm — the DCC standard:
      //   1. Build a Box3 from every VISIBLE mesh group (walls + floor
      //      + ceiling + speakers + listeners + treatments + zone
      //      catwalks + aim lines + racks). NOT the abstract room
      //      AABB — we want the SILHOUETTE the renderer will actually
      //      draw, including speaker meshes and panels that poke past
      //      the room shell.
      //   2. Use the box center (not h*0.4 of the room) so the framing
      //      is balanced around what's actually visible.
      //   3. Start with the bounding-sphere fit as an initial distance
      //      (overshoots → safe lower bound for iteration).
      //   4. Iterate: project all 8 corners through the candidate view
      //      matrix → NDC. Find max(|ndc.x|, |ndc.y|). Rescale distance
      //      so that max == TARGET_NDC (0.90 → 5 % gap each side).
      //   5. Converges in 3-4 passes because (a) the projection is
      //      monotonic in distance along the fixed camera direction
      //      and (b) the binding corner rarely changes between passes.

      // Gather visible groups. Skip heatmapGroup / heatmapMesh (they
      // extend past walls and are an overlay, not geometry) and the
      // floor grid (already hidden during capture). _floorGrid stays
      // visible during interactive use but its extent doesn't matter
      // because we're framing the room subject.
      const groups = [];
      if (roomGroup        && roomGroup.visible)        groups.push(roomGroup);
      if (sourcesGroup     && sourcesGroup.visible)     groups.push(sourcesGroup);
      if (listenersGroup   && listenersGroup.visible)   groups.push(listenersGroup);
      if (treatmentsGroup  && treatmentsGroup.visible)  groups.push(treatmentsGroup);
      if (zonesGroup       && zonesGroup.visible)       groups.push(zonesGroup);
      if (typeof racksGroup    !== 'undefined' && racksGroup    && racksGroup.visible)    groups.push(racksGroup);
      if (typeof aimLinesGroup !== 'undefined' && aimLinesGroup && aimLinesGroup.visible) groups.push(aimLinesGroup);

      const box = new THREE.Box3();
      let havePoints = false;
      for (const g of groups) {
        // expandByObject traverses children and unions every mesh's
        // world-space AABB. Returns the original box (mutating).
        const before = box.isEmpty();
        box.expandByObject(g);
        if (before && !box.isEmpty()) havePoints = true;
        else if (!box.isEmpty()) havePoints = true;
      }

      // Degenerate fallback — boot before the scene is populated, or
      // every group hidden. Use the abstract room AABB.
      if (!havePoints || box.isEmpty()) {
        box.min.set(minX, 0, minZ);
        box.max.set(maxX, h, maxZ);
      }

      // Centre of the visible content, NOT h*0.4 of the room. Looks
      // more balanced when treatments / line arrays push the visible
      // box upward.
      const targetPos = box.getCenter(new THREE.Vector3());
      // Iso direction — steeper pitch (~32°) for a more dramatic 3/4
      // aerial view. Previously (0.9, 0.5, 0.4) gave ~27° pitch which
      // read as flat in a square frame; (0.85, 0.6, 0.45) lifts the
      // camera so the floor + room volume both project visibly without
      // losing the 3/4 "lean" of a classic iso.
      const dirToCam  = new THREE.Vector3(0.85, 0.6, 0.45).normalize();

      // Silhouette point set. For a CIRCULAR / POLYGON room the Box3
      // is the inscribed-cylinder's AABB — w × d × h with 4 corners
      // sitting in EMPTY space outside the room footprint. Fitting to
      // those corners pulls the camera back too far → ~20-25 % wasted
      // margin on octagons, 16-gon chambers, 36-gon domes.
      //
      // Fix: project the ACTUAL room polygon footprint × {floor,
      // ceiling}. roomPlanVertices(room) gives:
      //   - rectangular → 4 plan corners
      //   - polygon     → N plan vertices
      //   - round       → 64 sampled ring points
      //   - custom      → state.room.custom_vertices
      //
      // We still union with the visible-content Box3 (treatments /
      // speakers / racks that poke past the shell), so meshes outside
      // the room footprint never clip. Their Box3 corners get included
      // alongside the room silhouette points.
      const corners = [];
      try {
        const planVerts = roomPlanVertices(state.room);
        const floorY = box.min.y;
        const ceilY  = box.max.y;
        for (const v of planVerts) {
          corners.push(new THREE.Vector3(v.x, floorY, v.y));
          corners.push(new THREE.Vector3(v.x, ceilY,  v.y));
        }
      } catch (_) { /* no-op — fall through to bbox corners */ }
      // Always include the visible-content Box3 corners too. For a
      // rectangular room these match the plan vertices exactly (no
      // change to existing behaviour). For round / polygon rooms they
      // capture meshes that extend past the room footprint (e.g. a
      // line-array flown above the ceiling Box3 max-y, or a speaker
      // pole outside the polygon).
      corners.push(
        new THREE.Vector3(box.min.x, box.min.y, box.min.z),
        new THREE.Vector3(box.max.x, box.min.y, box.min.z),
        new THREE.Vector3(box.min.x, box.max.y, box.min.z),
        new THREE.Vector3(box.max.x, box.max.y, box.min.z),
        new THREE.Vector3(box.min.x, box.min.y, box.max.z),
        new THREE.Vector3(box.max.x, box.min.y, box.max.z),
        new THREE.Vector3(box.min.x, box.max.y, box.max.z),
        new THREE.Vector3(box.max.x, box.max.y, box.max.z),
      );

      const fovV = THREE.MathUtils.degToRad(camera.fov || 38);
      const aspect = Math.max(camera.aspect || 1, 0.1);
      const tanHalfV = Math.tan(fovV / 2);
      const tanHalfH = tanHalfV * aspect;          // h-FOV derived from v-FOV + aspect
      // 5 % visible gap each side ⇒ binding corner sits at 90 % of the
      // frustum half-extent (in NDC units, 0.90 of 1.0).
      // 0.96 = 4 % visible gap each side — tight enough that the room
      // fills the captured square without obvious wasted margin, loose
      // enough that mesh chrome / line strokes never kiss the edge.
      // Previously 0.90 (10 % gap) left the room looking small in the
      // printed cover.
      const TARGET_NDC = 0.96;

      // Initial guess — bounding-sphere fit. Always overshoots (sphere
      // is larger than the projected silhouette) so iteration can only
      // pull IN, never push past valid distances.
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const sphereR = Math.max(sphere.radius, 0.5);
      const minHalfFov = Math.min(fovV / 2, 2 * Math.atan(tanHalfH) / 2);
      let dist = sphereR / Math.sin(minHalfFov);

      // Iterate. View basis stays constant (we only move along
      // dirToCam, target fixed), so we can build it once.
      const viewDir = dirToCam.clone().negate();    // camera → target
      const worldUp = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(worldUp, viewDir).normalize();
      const up    = new THREE.Vector3().crossVectors(right, viewDir).normalize();
      // up = right × viewDir gives a right-handed view basis where +viewDir
      // is into the screen (camera looks along viewDir toward target).

      const tmp = new THREE.Vector3();
      for (let iter = 0; iter < 6; iter++) {
        const camPos = targetPos.clone().addScaledVector(dirToCam, dist);
        let maxFracH = 0, maxFracV = 0;
        for (const c of corners) {
          tmp.copy(c).sub(camPos);
          // View-space: x = tmp·right, y = tmp·up, z = tmp·viewDir.
          // z is positive when corner is in front of the camera.
          const vx = tmp.dot(right);
          const vy = tmp.dot(up);
          const vz = tmp.dot(viewDir);
          if (vz <= 1e-3) continue;                 // behind / on camera; skip
          // NDC x = vx / (vz·tanHalfH), NDC y = vy / (vz·tanHalfV).
          // We want max |NDC| across corners.
          const fracH = Math.abs(vx) / (vz * tanHalfH);
          const fracV = Math.abs(vy) / (vz * tanHalfV);
          if (fracH > maxFracH) maxFracH = fracH;
          if (fracV > maxFracV) maxFracV = fracV;
        }
        const maxFrac = Math.max(maxFracH, maxFracV);
        if (maxFrac <= 1e-4) break;                 // degenerate, leave dist
        // Rescale: we want maxFrac == TARGET_NDC. Because the binding
        // corner's vz changes with dist (it's not at target depth),
        // a single multiplicative correction undershoots — but applying
        // it repeatedly converges geometrically. 3-4 passes is enough
        // in practice; 6 is the safety cap.
        const scale = maxFrac / TARGET_NDC;
        const newDist = dist * scale;
        // If the correction is < 0.5 % we've converged. Bail to avoid
        // FP wobble on the last decimals.
        if (Math.abs(newDist - dist) / dist < 0.005) { dist = newDist; break; }
        dist = newDist;
      }

      return {
        targetPos,
        targetCam: targetPos.clone().add(dirToCam.multiplyScalar(dist)),
      };
    }
  }
}

// Build tag so a user can confirm the live module matches the fix in
// case of stale-cache reports. Logged once at module load.
try {
  console.info('[scene] build 2026-05-13 v360 — iterativeIsoFit');
} catch (_) { /* server-side noop */ }

// One-time build stamp so the user can confirm a fresh module is live
// in the browser (vs a cached older copy). Bumped each time the
// capture/fit path changes shape.
try {
  if (typeof console !== 'undefined' && !window.__roomlab_scene_build_logged) {
    console.info('[scene] build 2026-05-13 v362 — captureViewportImage shape-aware fit + wall-opacity boost');
    window.__roomlab_scene_build_logged = true;
  }
} catch (_) { /* noop */ }

// Capture the current 3D viewport as a PNG data URL, framed to a named
// camera preset (default: 'iso'). Used by the print-report cover to
// embed a hero-sized perspective render of the room.
//
// Implementation notes — Viktor's brief:
//   1. Synchronously SNAP the camera to the preset (no tween) so we
//      don't have to await any rAF chain. The user's existing camera
//      state is stashed and restored in `finally`.
//   2. Render to an off-screen WebGLRenderTarget instead of the canvas
//      back buffer. This sidesteps two problems at once:
//        a. Martina's flag: the renderer is constructed WITHOUT
//           preserveDrawingBuffer (intentional — Martina's HIGH on
//           the print-report.js intro). canvas.toDataURL() on the
//           live canvas would intermittently come back blank.
//        b. We can render at any size (1400×900) without first
//           resizing the visible renderer / restoring it. Less risk
//           of the viewport flashing during the capture.
//   3. Walk mode returns null — capture only makes sense from the
//      OrbitControls free camera. The print-report cover falls back
//      to the 2D plan in this case.
//   4. WebGL context loss / readback failure returns null.
//
// Print background — white during the off-screen capture, then restored.
// Constructed once at module scope so we don't churn THREE.Color objects
// across repeat prints.
// Near-white print background. Pure #ffffff makes transparent walls
// (opacity ~0.55) vanish against the page; #fafafa preserves ink-friendly
// brightness but gives transparent surfaces a faint grey to multiply
// against, so the room silhouette never disappears entirely.
const _printCaptureBackground = new THREE.Color(0xffffff);

// Returns string|null synchronously. Use await Promise.resolve(...) at
// the call site if a Promise contract is wanted.
export function captureViewportImage(opts = {}) {
  if (!renderer || !scene || !camera) return null;
  if (walkMode) {
    console.warn('[scene] captureViewportImage skipped — walk mode active');
    return null;
  }
  const width  = Math.max(200, Math.floor(opts.width  ?? 1400));
  const height = Math.max(150, Math.floor(opts.height ?? 900));
  const presetName = opts.preset ?? 'iso';

  // --- Stash live camera + scene state we'll mutate -------------------
  const prevAspect = camera.aspect;
  const prevCamPos = camera.position.clone();
  const prevTarget = controls ? controls.target.clone() : null;
  const prevTween = _focusTween;
  const prevBackground = scene.background;        // swap to white for print, restore after
  const prevGridVisible = _floorGrid ? _floorGrid.visible : null;
  // Hide audience FIGURES during capture (kept from previous commit —
  // helps even at small scale for arenas with seating).
  const prevAudienceVisible = audienceGroup ? audienceGroup.visible : null;
  // ROOT CAUSE for arena black-blob (Martina audit): scene.fog is a
  // linear Fog(slate, 55, 110). Live OrbitControls clamps maxDistance
  // to 80 so users never enter heavy-fog territory. The iso capture
  // preset places the camera 85-150 m from a Pavilion 80×40×23 or a
  // Dome 60×60×12, so the entire room sits past fog.far → saturated to
  // dark slate → mixed over the white capture background = the black
  // blob symptom we kept misdiagnosing. Stash + null fog for capture.
  const prevFog = scene.fog;
  const prevExposure = renderer ? renderer.toneMappingExposure : 1.0;

  // ---- Capture-only frustum expansion (real fix for "arena prints black") ----
  // Two compounding bugs were turning Pavilion / Dome interiors black in print:
  //
  // (a) camera.far = 300 m. The iso preset places the camera so far back that
  //     the far edge of an 80×40×23 m room can sit past the perspective near/far
  //     plane → far wall clips.
  // (b) Shadow camera frustum is fixed at ±45 m × 120 m far. For arena-scale
  //     rooms the floor + far wall sit OUTSIDE the shadow camera frustum, and
  //     Three.js's PCFSoftShadowMap samples outside-map texels as fully shadowed
  //     → floor renders pitch black despite normal lighting.
  //
  // Stash + expand both based on the room's AABB diagonal; restore in finally.
  // Previous bandaid was boosting ambient/hemi intensity, which washed out small
  // rooms without fixing the root issue.
  let prevCamFar = null;
  let prevKeyShadow = null;
  try {
    const aabb = _roomWorldAABB?.();
    if (aabb && camera) {
      const roomDiag = Math.hypot(aabb.w ?? 10, aabb.d ?? 10, aabb.h ?? 3);
      prevCamFar = camera.far;
      camera.far = Math.max(prevCamFar, roomDiag * 4);
      camera.updateProjectionMatrix();
      if (_keyLight && _keyLight.shadow) {
        const sc = _keyLight.shadow.camera;
        prevKeyShadow = {
          L: sc.left, R: sc.right, T: sc.top, B: sc.bottom, F: sc.far,
        };
        // EXPAND-ONLY: never shrink below the live defaults. Small rooms
        // (octagon, chamber) need the original ±45 m frustum at high
        // texel density; shrinking to fit the small room makes the
        // shadow rig hug too tight and the room reads washed out.
        const need = Math.max(aabb.w ?? 10, aabb.d ?? 10) * 0.75;
        const r = Math.max(prevKeyShadow.R, prevKeyShadow.T, need);
        sc.left = -r; sc.right = r;
        sc.top = r;   sc.bottom = -r;
        sc.far = Math.max(prevKeyShadow.F, roomDiag * 2);
        sc.updateProjectionMatrix();
        _keyLight.shadow.needsUpdate = true;
      }
    }
  } catch (e) { /* leave defaults if AABB read fails */ }

  // Wall-opacity boost (Viktor v362) was reverted: it made dark walls
  // print fully black AND light walls (gypsum, white plaster) blend
  // into the white background. The original opacity (~0.55) keeps the
  // transparent-wall aesthetic that works in the live viewport. Large
  // rooms still render dim — that's a separate issue (light rig not
  // scaled to room volume), tracked for a follow-up.
  let dataUrl = null;
  let rt = null;
  try {
    // --- Print-friendly background — white instead of the dark slate
    // the live viewport uses. Saves ink on the printed page and lets the
    // 2D-plan inset overlap the hero without a noisy contrast jump.
    scene.background = _printCaptureBackground;

    // --- Hide the 60×60 GridHelper backdrop. In the live viewport it
    // reads as a subtle floor reference; in the printed cover it
    // extends past the room and looks like a cropped wood floor. The
    // room is the subject — drop the surrounding noise.
    if (_floorGrid) _floorGrid.visible = false;
    if (audienceGroup) audienceGroup.visible = false;
    scene.fog = null;       // <-- THE FIX. Stops far-room saturation to fog colour.
    // Mild exposure lift — fog was contributing implicit depth-darkening
    // that now removed leaves the render slightly flat. 1.15× is just
    // enough contrast to keep arena hero pieces "premium" without washing
    // out the small rooms that already work.
    if (renderer) renderer.toneMappingExposure = prevExposure * 1.15;

    // (Lighting boost removed — was washing out small rooms without
    // fixing the arena-black-floor root cause. Real fix is the
    // camera.far + shadow-frustum expansion above.)

    // --- Snap camera to preset (synchronous, bypasses the tween) ----
    // Set camera.aspect to MATCH the capture aspect so the preset's
    // fit-distance math (in _cameraPresetTransform → _fitDistance)
    // frames the room for the PNG's aspect, not the screen's.
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const t = _cameraPresetTransform(presetName);
    if (t) {
      camera.position.copy(t.targetCam);
      if (controls) controls.target.copy(t.targetPos);
      // The iso preset now uses AABB-corner projection fit with a 1.05
      // margin built in. No extra pull-back needed for capture — the
      // preset already produces a tight, edge-aware framing.
      const CAPTURE_PULL_BACK = 1.00;
      const dir = new THREE.Vector3().subVectors(camera.position, t.targetPos);
      camera.position.copy(t.targetPos).addScaledVector(dir, CAPTURE_PULL_BACK);
      camera.lookAt(t.targetPos);
    }
    // Kill any in-flight tween so _tickCameraFocus on the next
    // animate() frame doesn't drag the camera away from the preset
    // before our restore runs.
    _focusTween = null;

    // --- Off-screen render target ------------------------------------
    rt = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
    });
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(prevRT);

    // --- Read pixels back to a typed array ---------------------------
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, width, height, pixels);

    // --- Encode via a 2D canvas (no preserveDrawingBuffer needed) ---
    // readRenderTargetPixels returns rows bottom-up (OpenGL convention).
    // Flip vertically while copying into the 2D canvas so the PNG is
    // top-down (HTML/print convention).
    const enc = document.createElement('canvas');
    enc.width = width;
    enc.height = height;
    const ctx = enc.getContext('2d');
    const imgData = ctx.createImageData(width, height);
    const dst = imgData.data;
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      const srcOff = (height - 1 - y) * rowBytes;
      const dstOff = y * rowBytes;
      dst.set(pixels.subarray(srcOff, srcOff + rowBytes), dstOff);
    }
    ctx.putImageData(imgData, 0, 0);
    try {
      dataUrl = enc.toDataURL('image/png');
    } catch (err) {
      console.warn('[scene] toDataURL failed:', err);
      dataUrl = null;
    }
  } catch (err) {
    console.warn('[scene] captureViewportImage failed:', err);
    dataUrl = null;
  } finally {
    // --- Restore camera + dispose render target ----------------------
    try {
      camera.aspect = prevAspect;
      camera.updateProjectionMatrix();
      camera.position.copy(prevCamPos);
      if (controls && prevTarget) controls.target.copy(prevTarget);
      _focusTween = prevTween;
      scene.background = prevBackground;
      if (_floorGrid && prevGridVisible !== null) _floorGrid.visible = prevGridVisible;
      if (audienceGroup && prevAudienceVisible !== null) audienceGroup.visible = prevAudienceVisible;
      scene.fog = prevFog;
      if (renderer) renderer.toneMappingExposure = prevExposure;
      // Restore camera.far + shadow camera frustum if we touched them.
      if (camera && prevCamFar !== null) {
        camera.far = prevCamFar;
        camera.updateProjectionMatrix();
      }
      if (_keyLight && _keyLight.shadow && prevKeyShadow) {
        const sc = _keyLight.shadow.camera;
        sc.left   = prevKeyShadow.L;
        sc.right  = prevKeyShadow.R;
        sc.top    = prevKeyShadow.T;
        sc.bottom = prevKeyShadow.B;
        sc.far    = prevKeyShadow.F;
        sc.updateProjectionMatrix();
        _keyLight.shadow.needsUpdate = true;
      }
      if (rt) rt.dispose();
      // No need to re-render — we never touched the live canvas's
      // back buffer (everything went to the off-screen render target).
    } catch (err) {
      console.warn('[scene] capture restore failed:', err);
    }
  }
  return dataUrl;
}

// Public — kick off a smooth tween to one of the named presets.
// 'top' | 'front' | 'back' | 'left' | 'right' | 'iso'
export function applyCameraPreset(name) {
  if (walkMode || !camera || !controls) return;
  const t = _cameraPresetTransform(name);
  if (!t) return;
  _focusTween = {
    targetPos: t.targetPos,
    targetCam: t.targetCam,
    startPos: controls.target.clone(),
    startCam: camera.position.clone(),
    t0: performance.now(),
    durationMs: 500,
  };
}

// Best-guess which preset the camera is currently sitting near. Returns
// one of the 6 names, or null if the current view is "in between" any
// preset (e.g. the user has manually orbited away). Used purely to
// decorate the active button — never to drive behavior. Heuristic:
// for each preset, compute the expected (camPos, target) and measure
// the camera offset's angular distance from the preset's offset. If
// the closest preset is within ~12° on the unit-direction, treat it
// as "active"; otherwise return null.
export function detectActiveCameraPreset() {
  if (!camera || !controls || walkMode) return null;
  const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
  if (offset.lengthSq() < 1e-6) return null;
  const dir = offset.clone().normalize();
  const names = ['top', 'front', 'back', 'left', 'right', 'iso'];
  let best = null;
  let bestDot = -2;
  for (const name of names) {
    const t = _cameraPresetTransform(name);
    if (!t) continue;
    const pdir = new THREE.Vector3().subVectors(t.targetCam, t.targetPos).normalize();
    const dot = dir.dot(pdir);
    if (dot > bestDot) { bestDot = dot; best = name; }
  }
  // ~12° threshold (cos 12° ≈ 0.978). Tight enough that we don't
  // false-positive once the user starts dragging the orbit.
  return bestDot > 0.978 ? best : null;
}

// Cabinet dimensions in meters by speaker type. Line-array elements are
// scaled slightly larger than real-world (~1.2m × 0.42m × 0.7m, vs Nexo STM
// M46 at 1.28 × 0.48 × 0.69) so they remain readable from arena-scale camera
// distances. Visual-only — physics still runs against the loudspeaker JSON
// directivity.
function speakerCabinetDims(modelUrl) {
  const url = modelUrl || '';

  // Ceiling speakers declare themselves via `mount_type: 'ceiling'` in the
  // JSON. When present, use the real-world outer diameter + cabinet depth
  // directly so the cabinet shown in the 3D viewport matches the spec-
  // sheet geometry (same shape as the Speaker-workbench preview).
  const def = getCachedLoudspeaker(url);
  if (def?.mount_type === 'ceiling' && def?.physical?.dimensions_m) {
    const dim = def.physical.dimensions_m;
    return {
      w: dim.w ?? 0.2,
      h: dim.h ?? 0.1,
      d: dim.d ?? dim.w ?? 0.2,
      type: 'ceiling',
      shape: def.physical?.shape || 'round',
      driverInches: def.physical?.driver_size_inches ?? 6,
      isCoax: /coaxial|co-axial/i.test(def.model || ''),
      isAmperes: /amperes/i.test(def.manufacturer || '') || /^amperes-/i.test(def.id || ''),
    };
  }

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

// Ceiling-speaker enclosure — cylinder (or square box for CS518 / similar)
// with a flat grille on the local +Z face and a visible driver cone behind
// it. Shape mirrors the js/ui/speaker-3d-preview.js builder.
//
// Orientation note: Three.js Object3D.lookAt() on a NON-camera object
// aligns the object's local +Z axis with the direction toward the
// target (the opposite of cameras, which use −Z). Since the cabinet is
// positioned with encl.lookAt(pos + aim) in rebuildSources(), the
// baffle MUST live at local +Z for the grille to face the aim
// direction. Earlier revisions put the baffle at −Z — the "butt" ended
// up firing at the audience.
function buildCeilingSpeakerEnclosure(dims, groupInt, outside) {
  const { w, h, shape, driverInches, isCoax, isAmperes } = dims;
  const radius = w / 2;
  const depth = h;                    // front-to-back cabinet depth
  const isSquare = shape === 'square';

  // Dramatic front-to-back taper so the baffle side is unmistakably the
  // larger face — matches real ceiling cabinets whose rear bowl hides
  // inside the ceiling tile while the visible grille sticks out.
  const rearR = radius * 0.72;

  const bodyColor = outside ? 0x6a1a0c : 0xe9ebee;
  const bodyMat = new THREE.MeshStandardMaterial({
    color: bodyColor, roughness: 0.72, metalness: 0.08,
  });
  let bodyGeo;
  if (isSquare) {
    bodyGeo = new THREE.BoxGeometry(w, w, depth * 0.9);
  } else {
    // Top of cylinder (+Y in local geom) becomes +Z after rotateX(+π/2).
    // Put the LARGER radius there so the front (+Z = aim direction)
    // reads as the baffle.
    bodyGeo = new THREE.CylinderGeometry(radius, rearR, depth * 0.9, 36);
    bodyGeo.rotateX(Math.PI / 2);
  }
  const body = new THREE.Mesh(bodyGeo, bodyMat);

  // Bezel ring just IN FRONT of the body (+Z side) — the visible trim
  // below a real ceiling tile.
  const bezelMat = new THREE.MeshStandardMaterial({
    color: outside ? 0xff5a3c : 0xdadee2, roughness: 0.6, metalness: 0.25,
  });
  let bezelGeo;
  if (isSquare) {
    bezelGeo = new THREE.BoxGeometry(w * 1.05, w * 1.05, depth * 0.05);
  } else {
    bezelGeo = new THREE.CylinderGeometry(radius * 1.04, radius * 1.04, depth * 0.05, 36);
    bezelGeo.rotateX(Math.PI / 2);
  }
  const bezel = new THREE.Mesh(bezelGeo, bezelMat);
  bezel.position.z = +depth / 2 - depth * 0.02;

  // Grille disc (or square) on the +Z face — tinted by speaker group.
  const grilleColor = groupInt ?? 0xd6dade;
  const grilleEmissive = outside ? 0x551100 : (groupInt ? (groupInt & 0x2a2a2a) : 0x141414);
  const grilleMat = new THREE.MeshStandardMaterial({
    color: grilleColor, roughness: 0.45, metalness: 0.25,
    emissive: grilleEmissive, side: THREE.DoubleSide,
  });
  const grilleGeo = isSquare
    ? new THREE.PlaneGeometry(w * 0.94, w * 0.94)
    : new THREE.CircleGeometry(radius * 0.92, 36);
  const grille = new THREE.Mesh(grilleGeo, grilleMat);
  const grilleZ = +depth / 2 + 0.003;
  grille.position.z = grilleZ;
  // Default CircleGeometry/PlaneGeometry faces +Z — no rotation needed.

  // Woofer cone visible through the grille, pointing apex outward (+Z).
  const driverR = Math.min(radius * 0.72, driverInches * 0.0127);
  const coneDepth = depth * 0.25;
  const coneMat = new THREE.MeshStandardMaterial({
    color: 0x16191f, roughness: 0.65, metalness: 0.22,
  });
  const coneGeo = new THREE.ConeGeometry(driverR * 0.95, coneDepth, 32, 1, true);
  coneGeo.rotateX(Math.PI / 2);       // apex (+Y originally) → +Z
  const cone = new THREE.Mesh(coneGeo, coneMat);
  cone.position.z = grilleZ - coneDepth * 0.55;   // set BACK from grille

  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(driverR * 0.24, 20, 14),
    new THREE.MeshStandardMaterial({ color: 0x2a2d34, roughness: 0.5, metalness: 0.3 }),
  );
  cap.position.z = grilleZ - 0.003;

  const encl = new THREE.Group();
  encl.add(body);
  encl.add(bezel);
  encl.add(grille);
  encl.add(cone);
  encl.add(cap);

  if (isCoax) {
    // Tweeter dome at the centre of the coax driver.
    const tweeterMat = new THREE.MeshStandardMaterial({
      color: 0x22252a, roughness: 0.35, metalness: 0.55,
    });
    const tweeter = new THREE.Mesh(
      new THREE.SphereGeometry(driverR * 0.18, 20, 14),
      tweeterMat,
    );
    tweeter.position.z = grilleZ - 0.001;
    encl.add(tweeter);
  }

  // Amperes "amperes" wordmark — embossed-style canvas text tag on the
  // grille (not the full scoreboard PNG). Transparent background so it
  // reads as a small brand plate rather than a rectangular sticker.
  if (isAmperes) {
    const textTex = getAmperesTextTexture();
    const textW = (isSquare ? w : radius * 2) * 0.28;
    const textH = textW * 0.25;        // 768 × 192 canvas → 4:1
    const badge = new THREE.Mesh(
      new THREE.PlaneGeometry(textW, textH),
      new THREE.MeshBasicMaterial({ map: textTex, transparent: true }),
    );
    // Low on the grille, slightly in front of the grille plane.
    badge.position.set(0, -(isSquare ? w : radius * 2) * 0.32, grilleZ + 0.001);
    encl.add(badge);
  }

  encl.userData.acoustic_material = 'speaker_cabinet';
  encl.userData.speaker_type = 'ceiling';
  return encl;
}

// Builds a speaker enclosure group oriented so its front face (local -Z) points
// along the aim vector. Used by both lookAt() + optional roll-about-aim.
function buildSpeakerEnclosure(src, groupInt, outside) {
  const dims = speakerCabinetDims(src.modelUrl);
  const { w, h, d, type } = dims;

  // Ceiling speakers get their own builder (round disc with grille + cone
  // behind) — same geometry as the Speaker-workbench preview so the
  // model looks consistent across the app.
  if (type === 'ceiling') return buildCeilingSpeakerEnclosure(dims, groupInt, outside);

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
  // Opt the wireframe OUT of raycasting. Three.js's default Line raycast
  // threshold is 1 m — so without this, hovering up to a metre from the
  // cabinet edge would trigger the speaker hover highlight. The solid
  // body / grill / driver meshes still pick at pixel accuracy.
  edges.raycast = () => {};

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

function rebuildSources() { shadowsNeedRefresh = true;
  // Highlight state holds a reference to a specific speaker Group; when
  // the whole sourcesGroup is replaced, that reference becomes stale and
  // the next pointermove would try to un-highlight a disposed Group.
  _hoveredSpeakerGroup = null;
  if (renderer) renderer.domElement.style.cursor = '';
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

  // Walk state.sources directly so each enclosure can be tagged with its
  // parent's index in state.sources (needed to jump the Sources side-panel
  // to the clicked speaker's config card). For a line-array entry, every
  // expanded element shares the same sourceIndex = the array's index in
  // state.sources; clicking any element in the column scrolls to the same
  // side-panel card.
  for (let sourceIdx = 0; sourceIdx < state.sources.length; sourceIdx++) {
    const original = state.sources[sourceIdx];
    const elements = original.kind === 'line-array'
      ? expandSources([original])
      : [original];
    for (const src of elements) {
      const outside = !isInsideRoom3D(src.position, state.room);
      const groupHex = src.groupId ? colorForGroup(src.groupId) : null;
      const groupInt = groupHex ? parseInt(groupHex.slice(1), 16) : null;

      const encl = buildSpeakerEnclosure(src, groupInt, outside);
      encl.position.set(src.position.x, src.position.z, src.position.y);
      // Tag the enclosure + every child mesh with modelUrl (for the Speaker-
      // workbench raycast handler) AND sourceIndex (for the Sources side-
      // panel jump handler).
      encl.userData.speakerModelUrl = src.modelUrl;
      encl.userData.sourceIndex = sourceIdx;
      encl.traverse(child => {
        child.userData.speakerModelUrl = src.modelUrl;
        child.userData.sourceIndex = sourceIdx;
      });

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

  rebuildAimLines();
}

// Raycaster used for aim-line termination. Allocated once so per-element
// aim-line construction stays cheap.
const _aimRaycaster = new THREE.Raycaster();

// Builds the aim-line indicators: for every speaker element, cast a ray
// from its acoustic center along its aim vector and terminate the line at
// the first hit with room geometry (walls, floor, dome, bowl concrete).
// Lines extend up to 120 m if nothing is in the path.
// Rebuild every PA equipment rack from state.rackSystem.racks. The
// `setRackCatalogues({ rackCatalogue, ampCatalog })` call from main.js
// must have already run before any rebuild reaches this — racks render
// as empty frames if the catalogue is missing (graceful degrade).
function rebuildRacks() {
  if (!racksGroup) {
    racksGroup = new THREE.Group();
    racksGroup.name = 'racks';
    scene.add(racksGroup);
  } else {
    disposeGroup(racksGroup);
  }
  const racks = state.rackSystem?.racks ?? [];
  if (racks.length === 0 || !_rackCatalogue) return;
  const ampList = Array.isArray(_ampCatalog) ? _ampCatalog : [];
  for (const rack of racks) {
    const g = buildRackGroup(rack, ampList, _rackCatalogue);
    // Coordinate swap from state to Three.js. State (x, y, z) where
    // z = up; Three (x, y_up, z_depth). Same convention used everywhere
    // else in scene.js.
    g.position.set(rack.position?.x ?? 0, rack.position?.z ?? 0, rack.position?.y ?? 0);
    g.rotation.y = ((rack.yaw_deg ?? 0) * Math.PI) / 180;
    racksGroup.add(g);
  }
}

// 2D ray-vs-polygon-edges first hit. Each polygon vertex is { x, y } in
// state plan coords (state-y maps to world-z). Used as the room-footprint
// clamp for aim lines so they never project past the perimeter even when
// the ray exits over the wall top in outdoor / no-roof rooms.
function polygonRayExitT(originX, originZ, dirX, dirZ, polyVerts) {
  if (!polyVerts || polyVerts.length < 3) return Infinity;
  let bestT = Infinity;
  const n = polyVerts.length;
  for (let i = 0; i < n; i++) {
    const a = polyVerts[i];
    const b = polyVerts[(i + 1) % n];
    const sdx = b.x - a.x;
    const sdz = b.y - a.y;
    const denom = dirX * sdz - dirZ * sdx;
    if (Math.abs(denom) < 1e-9) continue;     // parallel
    const ex = a.x - originX;
    const ez = a.y - originZ;
    const t = (ex * sdz - ez * sdx) / denom;
    const u = (ex * dirZ - ez * dirX) / denom;
    if (t > 1e-4 && u >= -1e-6 && u <= 1 + 1e-6 && t < bestT) bestT = t;
  }
  return bestT;
}

// 2D point-in-polygon (ray cast on +X). Polygon vertices are { x, y } in
// state coords — caller supplies the point in the same frame.
function pointInPolygon2D(px, py, verts) {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i].x, yi = verts[i].y;
    const xj = verts[j].x, yj = verts[j].y;
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// Where does the aim ray first cross an audience-zone surface plane?
// For each zone we treat its elevation as a horizontal plane and check
// that the ray's intersection with that plane lies inside the zone's
// polygon. This terminates aim arrows on the AUDIENCE TIER even when the
// geometric ray flies above tier-height meshes (the most common arena
// case: a high line-array element aimed nearly horizontally toward the
// far audience — the geometric ray would otherwise sail over every tier
// and only stop at the perimeter wall on the opposite side).
//
// Origin is in WORLD coords (x, y, z). Direction is normalised world.
// State zone polygon vertices are (x, y) in state coords where state-y
// maps to world-z. Zone elevation_m is world-y.
function audienceZoneTerminusT(originX, originY, originZ, dirX, dirY, dirZ, zones) {
  if (!zones || zones.length === 0) return Infinity;
  if (Math.abs(dirY) < 1e-6) return Infinity;   // ray runs parallel to every tier plane
  let bestT = Infinity;
  for (const zone of zones) {
    if (!zone || !Array.isArray(zone.vertices) || zone.vertices.length < 3) continue;
    const elev = (zone.elevation_m ?? 0) + 0.01;   // tier surface; +1 cm offset matches zone heatmap layer
    const t = (elev - originY) / dirY;
    if (t < 1e-4 || t >= bestT) continue;
    const cx = originX + t * dirX;
    const cz = originZ + t * dirZ;
    // state x = world x; state y = world z.
    if (pointInPolygon2D(cx, cz, zone.vertices)) bestT = t;
  }
  return bestT;
}

function rebuildAimLines() {
  if (!aimLinesGroup) {
    aimLinesGroup = new THREE.Group();
    scene.add(aimLinesGroup);
  } else {
    disposeGroup(aimLinesGroup);
  }
  if (!roomGroup) return;
  const MAX_AIM_LEN = 200;
  const FALLBACK_LEN = 6;   // tight fallback so a ray that misses every
                            // candidate (open-sky / over-the-wall aim)
                            // shows a short stub direction indicator
                            // rather than streaking across the whole room

  // Cast against room geometry AND every group whose meshes are real
  // surfaces a sound ray could land on:
  //   roomGroup    — walls, floor, ceiling, plus the LatheGeometry bowl
  //   zonesGroup   — audience-zone planes (cover bowl gaps at seat height)
  //   heatmapGroup — bowl-conforming SPL heatmap. CRITICAL: when the user
  //                  toggles heatmap OFF, heatmapGroup.visible flips to
  //                  false. Three.js Raycaster.intersectObjects() respects
  //                  .visible — invisible meshes are silently skipped, so
  //                  the smooth-bowl heatmap layer becomes a raycast HOLE
  //                  exactly where seating tiers should stop the arrow.
  //                  This was the primary failure mode for the Sport Arena
  //                  shoot-through report. We work around it below by
  //                  walking targets manually with traverseAll() and
  //                  invoking mesh.raycast() directly, ignoring .visible.
  //   audienceGroup — seated figures on every tier (InstancedMesh).
  const targetGroups = [roomGroup];
  if (zonesGroup)    targetGroups.push(zonesGroup);
  if (heatmapGroup)  targetGroups.push(heatmapGroup);
  if (audienceGroup) targetGroups.push(audienceGroup);

  // Tags we actively skip when picking the first hit. Line / contour /
  // helper tags only — meshes that ARE the audible surface (heatmap_layer,
  // heatmap_court, audience_body/head, stadium*, walls, floor, ceiling)
  // all qualify as valid aim termini.
  const SKIP_AIM_TAGS = new Set([
    'heatmap_contour', 'ray-viz-lines', 'walk_avatar',
  ]);

  // Collect every candidate mesh ONCE per rebuild. We walk descendants
  // ourselves (instead of letting intersectObjects(targets, true) do it)
  // because:
  //   1. .visible=false on a parent group propagates and silently hides
  //      every descendant from the raycaster — heatmapGroup with
  //      showHeatmaps=off was the smoking gun.
  //   2. Some meshes use side: THREE.FrontSide. For aim termination we
  //      want hits on either side (think wall-back-face, lathe sector
  //      with reversed winding). We force DoubleSide for the raycast and
  //      restore the original side after.
  //   3. We want zero ambiguity about which meshes are NOT in the target
  //      list — sourcesGroup, aimLinesGroup, listenersGroup, racksGroup
  //      are excluded by NOT being added to targetGroups, period.
  const candidateMeshes = [];
  const traverseAll = (obj) => {
    if (obj.isMesh) {
      const tag = obj.userData?.tag ?? '';
      if (!SKIP_AIM_TAGS.has(tag) && obj.geometry) {
        candidateMeshes.push(obj);
      }
    }
    if (obj.children) {
      for (const c of obj.children) traverseAll(c);
    }
  };
  for (const g of targetGroups) traverseAll(g);

  // Footprint polygon for the wall-line clamp — computed once per rebuild
  // so each aim line just runs a polygon ray-cast against it.
  const footprintVerts = roomPlanVertices(state.room);

  // Per-mesh raycast helper that bypasses .visible and forces DoubleSide.
  // mesh.raycast() pushes results into the array argument; we reuse a
  // scratch array per ray to avoid per-frame GC churn.
  const _aimHitScratch = [];
  const castAgainstMesh = (mesh, raycaster, out) => {
    const wasVisible = mesh.visible;
    // matrixWorld is read by mesh.raycast — we need it current even if the
    // mesh sat under an invisible parent. Group.updateWorldMatrix walks
    // upward, so this is cheap.
    if (!wasVisible) {
      mesh.visible = true;
      mesh.updateWorldMatrix(true, false);
    }
    let savedSide = null;
    const mat = mesh.material;
    if (mat && !Array.isArray(mat) && mat.side !== THREE.DoubleSide) {
      savedSide = mat.side;
      mat.side = THREE.DoubleSide;
    } else if (Array.isArray(mat)) {
      savedSide = mat.map(m => m.side);
      mat.forEach(m => { if (m) m.side = THREE.DoubleSide; });
    }
    try {
      mesh.raycast(raycaster, out);
    } catch (_) { /* defensive: bad geometry on a single mesh shouldn't drop the whole aim system */ }
    if (savedSide !== null) {
      if (Array.isArray(mat)) mat.forEach((m, i) => { if (m) m.side = savedSide[i]; });
      else mat.side = savedSide;
    }
    if (!wasVisible) mesh.visible = wasVisible;
  };

  for (const src of expandSources(state.sources)) {
    const groupHex = src.groupId ? colorForGroup(src.groupId) : null;
    const colour = groupHex ? parseInt(groupHex.slice(1), 16) : 0xffcc5a;

    const yr = src.aim.yaw * Math.PI / 180;
    const pr = src.aim.pitch * Math.PI / 180;
    // aim in state coords: (sin y · cos p, cos y · cos p, sin p).
    const ax = Math.sin(yr) * Math.cos(pr);
    const ay = Math.cos(yr) * Math.cos(pr);
    const az = Math.sin(pr);
    // state → Three.js: x→x, z→y (height), y→z (depth).
    const originWorld = new THREE.Vector3(src.position.x, src.position.z, src.position.y);
    const dirWorld = new THREE.Vector3(ax, az, ay).normalize();

    _aimRaycaster.set(originWorld, dirWorld);
    _aimRaycaster.far = MAX_AIM_LEN;
    _aimRaycaster.near = 0;

    // Manual gather — see traverseAll comment for why we don't use
    // intersectObjects.
    _aimHitScratch.length = 0;
    for (const m of candidateMeshes) {
      castAgainstMesh(m, _aimRaycaster, _aimHitScratch);
    }
    // intersectObjects sorts by distance for us; we have to do it ourselves.
    _aimHitScratch.sort((a, b) => a.distance - b.distance);

    // First valid hit. The skip-tag filter has already pruned helper meshes
    // above; the only thing left to filter here is hits with non-positive
    // distance (degenerate when the speaker sits exactly on a face).
    let dist = -1;
    for (const h of _aimHitScratch) {
      if (h.distance > 1e-4) { dist = h.distance; break; }
    }

    // Footprint clamp — find where the ray crosses ANY wall line (in the
    // 2D plan, with each wall extended vertically to infinity). This
    // covers the outdoor / no-roof case where the ray sails over the wall
    // mesh and would otherwise project far past the modelled space, and
    // it's also a defence-in-depth clamp for indoor when raycast geometry
    // is degenerate (e.g. a corner-grazing aim that misses every triangle).
    const tFootprint = polygonRayExitT(
      originWorld.x, originWorld.z, dirWorld.x, dirWorld.z, footprintVerts,
    );
    // Floor projection — when the ray heads downward, the y=0 plane is
    // also a candidate terminus.
    const tFloor = (dirWorld.y < -1e-3) ? -originWorld.y / dirWorld.y : Infinity;
    // Audience zone tier projection — terminates the arrow at the audience
    // SURFACE for arena-style scenes where a high line-array aimed nearly
    // horizontally would otherwise sail over every tier mesh and stop only
    // at the perimeter wall. Treats each zone as a horizontal tier plane;
    // if the ray crosses the plane within the zone's polygon, that's a
    // valid termination distance.
    const tZone = audienceZoneTerminusT(
      originWorld.x, originWorld.y, originWorld.z,
      dirWorld.x,    dirWorld.y,    dirWorld.z,
      state.zones,
    );

    if (dist > 0) {
      // Hit a real surface; still clamp to the closer of the wall-line
      // crossing, floor projection, or audience-zone tier projection so
      // we always favour the FIRST physically meaningful target.
      dist = Math.min(dist, tFootprint, tFloor, tZone, MAX_AIM_LEN);
    } else {
      // No raycast hit — pick the closest of footprint / floor / zone / cap.
      dist = Math.min(tFootprint, tFloor, tZone, MAX_AIM_LEN);
      if (!Number.isFinite(dist) || dist <= 0) dist = FALLBACK_LEN;
    }

    const end = originWorld.clone().addScaledVector(dirWorld, dist);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([originWorld, end]);
    const lineMat = new THREE.LineBasicMaterial({
      color: colour, transparent: true, opacity: 0.9,
    });
    aimLinesGroup.add(new THREE.Line(lineGeo, lineMat));

    // Arrowhead at the hit point, oriented along the aim direction.
    const head = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.6, 12),
      new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.95 }),
    );
    head.position.copy(end).addScaledVector(dirWorld, -0.3);  // offset back so tip sits on the hit
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirWorld);
    aimLinesGroup.add(head);

    // Small dot at the impact point — makes it crystal clear what each
    // speaker is aimed at.
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 12, 10),
      new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.95 }),
    );
    dot.position.copy(end);
    aimLinesGroup.add(dot);
  }

  aimLinesGroup.visible = !!state.display.showAimLines;
}

function rebuildListeners() { shadowsNeedRefresh = true;
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

// ---------------------------------------------------------------------------
// Treatments — visual-only placement of acoustic panels on walls / ceiling.
// Each entry in state.treatments renders as a thin rectangular Group facing
// into the room, with a coloured frame, the product fill, and a selection
// glow when state.selectedTreatmentId matches. Drag math (below) constrains
// movement to the anchored surface plane so the panel can never fly free.
// ---------------------------------------------------------------------------

function _treatmentColorFor(category) {
  // Match SurfaceLAB's per-rail palette intent: absorbers dark/charcoal,
  // diffusers warm wood, bass dark+amber, ceiling neutral grey.
  const seg = typeof category === 'string' ? category.split('.')[0] : 'absorber';
  switch (seg) {
    case 'diffuser': return 0xb69b6e;
    case 'bass':     return 0x3d3a36;
    case 'absorber': return 0x4a4742;
    default:         return 0x8a8580;
  }
}

let _treatmentMeshBuildLogged = false;
function _buildTreatmentMesh(t, spec) {
  if (!_treatmentMeshBuildLogged) {
    // One-time build stamp so a stale-cache report is distinguishable
    // from a code bug. If you don't see this log, hard-refresh.
    console.info('[scene] build 2026-05-13 v344 — treatment mesh uses SurfaceLAB buildSampleGroup');
    _treatmentMeshBuildLogged = true;
  }
  // Group wraps the body (rich SurfaceLAB geometry) + selection halo so
  // we can move / rotate as a unit. The group sits at the treatment's
  // anchor point with local +Z pointing along the inward wall normal.
  const group = new THREE.Group();
  const w = Math.max(0.05, t.dimensions?.width_m ?? 0.6);
  const h = Math.max(0.05, t.dimensions?.height_m ?? 0.6);
  const d = Math.max(0.01, t.dimensions?.depth_m ?? 0.05);

  // Body: use the same procedural builders SurfaceLAB's 3D preview
  // uses — QRD wells, foam wedges, polycyl arcs, BAD masks, corner-
  // trap prisms, etc. — so the placed panel matches the catalogue
  // preview instead of degrading to a flat box. buildSampleGroup
  // returns a fresh Group with back face at local z=0, body
  // extending into +Z — matches RoomLAB's placement convention.
  let body;
  if (spec) {
    body = buildSampleGroup(spec);
  } else {
    // Catalogue not resolved yet (cold-boot before loadSurfaceCatalogue
    // finishes). Fall back to a coloured box so the panel still appears;
    // rebuildTreatments kicks again on treatment:changed once the spec
    // arrives.
    const matColor = _treatmentColorFor(undefined);
    const stubGeo = new THREE.BoxGeometry(w, h, d);
    const stubMat = new THREE.MeshStandardMaterial({ color: matColor, roughness: 0.85, metalness: 0.05 });
    body = new THREE.Mesh(stubGeo, stubMat);
    body.position.z = d / 2;
  }
  // Every mesh inside the body is a real surface — pickable. Decorative
  // line segments (if any builder ever adds them) get opted out below.
  body.traverse(child => {
    if (child.isLineSegments || child.isLine) {
      child.userData.pickable = false;
      child.raycast = () => {};          // hard opt-out, line threshold is 1 m
    } else if (child.isMesh) {
      child.userData.pickable = true;
    }
  });
  group.add(body);

  // Selection halo — a slightly larger transparent plane behind the
  // panel face, cyan, only added when selected. Decoration only — DO
  // NOT register clicks; otherwise a wall click 7 cm from the panel
  // edge spuriously selects this treatment instead of the wall.
  if (t.id === state.selectedTreatmentId) {
    const haloGeo = new THREE.PlaneGeometry(w + 0.15, h + 0.15);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x00d4ff, transparent: true, opacity: 0.35,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.position.z = -0.01;
    halo.userData.pickable = false;
    halo.raycast = () => {};           // hard opt-out — halo never wins a pick
    group.add(halo);
  }

  // Tag every child so a raycast hit on any sub-mesh (QRD block, wedge
  // face, etc.) can walk up to find its parent treatment id. The
  // pickable filter above is independent; tagging the whole tree keeps
  // _findTreatmentFromHit's parent-chain walk fast.
  group.userData.tag = 'treatment';
  group.userData.treatmentId = t.id;
  group.userData.surface = t.anchor?.surface ?? 'wall';
  if (t.anchor?.wallIndex != null) group.userData.wallIndex = t.anchor.wallIndex;
  group.traverse(child => {
    child.userData.tag = child.userData.tag || 'treatment';
    child.userData.treatmentId = t.id;
  });
  return group;
}

// State-coord (x=width, y=depth, z=height) → world-coord (Three.js x, z=h, y=depth)
// helper. Applies the per-treatment orientation:
//   wall: face normal = inward normal of the wall edge; the panel sits
//         on the wall and projects into the room by d/2.
//   ceiling: face normal = -Y (downward), roll = rotation_deg.
function _placeTreatmentGroupOnSurface(group, t, polygonVerts) {
  const px = t.position.x;
  const py = t.position.y;
  const pz = t.position.z;
  if (t.anchor?.surface === 'ceiling') {
    // Sit flush at room height; face pointing DOWN. Default panel
    // orientation has face on +Z (group-local). Rotate -90° around X
    // so the face points downward (world -Y).
    group.position.set(px, pz, py);
    group.rotation.set(Math.PI / 2, ((t.rotation_deg || 0) * Math.PI) / 180, 0, 'YXZ');
    return;
  }
  // Wall anchor — orient so the panel face normal points INTO the room
  // along the wall's inward normal.
  if (!Array.isArray(polygonVerts) || polygonVerts.length < 2) {
    group.position.set(px, pz, py);
    return;
  }
  const idx = Number.isFinite(t.anchor?.wallIndex) ? t.anchor.wallIndex : 0;
  const a = polygonVerts[idx % polygonVerts.length];
  const b = polygonVerts[(idx + 1) % polygonVerts.length];
  // Edge tangent in state coords (x, y). Inward normal for a CCW
  // polygon in state coords is rotated 90° CCW from the tangent;
  // in Three.js (x, _, z=stateY) that's the right-hand rule yaw.
  const tx = b.x - a.x;
  const ty = b.y - a.y;
  const tlen = Math.hypot(tx, ty);
  if (tlen < 1e-6) {
    group.position.set(px, pz, py);
    return;
  }
  // World yaw (around Three.js +Y) such that the group's local +Z aligns
  // with the inward normal of the edge. In state coords the inward
  // normal (CCW polygon) is (-ty, tx) / tlen. In Three.js coords
  // (x → x, state-y → z) the normal points at world (-ty, _, tx).
  // The default group +Z direction in world is (0, 0, 1). We want
  // (-ty/tlen, 0, tx/tlen). Yaw = atan2(-ty, tx). Then roll = rotation_deg.
  const yaw = Math.atan2(-ty, tx);
  group.position.set(px, pz, py);
  group.rotation.set(0, yaw, ((t.rotation_deg || 0) * Math.PI) / 180, 'YXZ');
  // Translate the body forward along its own +Z by half-depth, but we
  // already centred the body at z=d/2 inside the group, so the back of
  // the panel sits on the wall plane. No extra offset needed.
}

function rebuildTreatments() {
  shadowsNeedRefresh = true;
  if (!scene) return;
  if (!treatmentsGroup) {
    treatmentsGroup = new THREE.Group();
    treatmentsGroup.name = 'treatments';
    scene.add(treatmentsGroup);
  } else {
    disposeGroup(treatmentsGroup);
  }
  const treatments = Array.isArray(state.treatments) ? state.treatments : [];
  if (treatments.length === 0) return;
  const polygonVerts = roomPlanVertices(state.room);

  for (const t of treatments) {
    if (!t || !t.position) continue;
    let spec = t._cachedSpec;
    if (!spec) {
      spec = findCatalogueEntry(t.productId);
      if (spec) t._cachedSpec = spec;
    }
    // spec may still be null on cold-boot before loadSurfaceCatalogue
    // has resolved. Render with defaults; rebuild kicks again when the
    // panel mount finishes and emits treatment:changed via its
    // catalogue-resolved render.
    const grp = _buildTreatmentMesh(t, spec);
    _placeTreatmentGroupOnSurface(grp, t, polygonVerts);
    treatmentsGroup.add(grp);
  }
}

// Re-anchor + orphan-rescue every wall-anchored treatment after a
// room change. Two cases:
//   (a) wallIndex still exists, but its vertices moved → re-project
//       the world XY onto the current segment so the panel stays
//       glued to the wall plane rather than drifting through it.
//   (b) wallIndex is out of range (room re-vertexed to fewer edges)
//       → re-project onto the nearest surviving wall and update
//       wallIndex. This is the "orphan rescue" path.
function reanchorTreatmentsOnRoomChange() {
  if (!Array.isArray(state.treatments) || state.treatments.length === 0) return;
  const polygonVerts = roomPlanVertices(state.room);
  if (!Array.isArray(polygonVerts) || polygonVerts.length < 3) return;
  // Step 1: rescue out-of-range indices (returns count, but we just
  // care that orphans got moved before step 2 runs).
  rescueOrphanedTreatments(polygonVerts);
  // Step 2: re-snap surviving wall anchors onto their (possibly moved)
  // segment. Ceiling anchors stay put; their position.z must track
  // room.height_m so a wall-shrink doesn't leave them hovering.
  const ceilingZ = state.room.height_m ?? 0;
  for (const t of state.treatments) {
    if (t.anchor?.surface === 'ceiling') {
      t.position.z = ceilingZ;
      continue;
    }
    if (t.anchor?.surface !== 'wall') continue;
    const idx = t.anchor.wallIndex;
    if (!Number.isFinite(idx)) continue;
    const proj = projectOntoWall(polygonVerts, idx,
      { x: t.position.x, y: t.position.y }, t.position.z);
    if (proj) {
      t.position.x = proj.position.x;
      t.position.y = proj.position.y;
    }
  }
}

// ---------------------------------------------------------------------------
// Treatment placement — armed by the panel, the next click on a wall (or
// the ceiling) drops a new treatment of the chosen productId at that
// surface coord. Lives entirely in scene.js because the raycast against
// the live roomGroup is here.
// ---------------------------------------------------------------------------
let _pendingPlacementProductId = null;
let _pendingPlacementSpec = null;
const _placeRay = new THREE.Raycaster();
const _placeNdc = { x: 0, y: 0 };

// Cursor-tip hint shown while placement is armed. The left-rail panel's
// "armed banner" is good but easy to miss when the user has already
// moved their eyes to the 3D viewport. This is a floating label that
// rides with the cursor inside the canvas — same affordance every CAD
// tool uses for "what mode am I in." Cleared by hideTreatmentPlacementHint.
let _placementHintEl = null;
let _placementHintBound = false;

function ensurePlacementHint() {
  if (_placementHintEl && document.body.contains(_placementHintEl)) return _placementHintEl;
  const el = document.createElement('div');
  el.className = 'treatment-placement-hint';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.style.cssText = [
    'position:fixed', 'z-index:10000', 'pointer-events:none',
    'padding:6px 10px', 'border-radius:4px',
    'background:rgba(15,18,24,0.92)',
    'border:1px solid rgba(74,163,255,0.55)',
    'box-shadow:0 4px 16px rgba(0,0,0,0.45)',
    'color:#e6edf3', 'font-family:Inter Tight, system-ui, sans-serif',
    'font-size:12px', 'line-height:1.35', 'white-space:nowrap',
    'opacity:0', 'transition:opacity 120ms ease-out',
  ].join(';');
  document.body.appendChild(el);
  _placementHintEl = el;
  return el;
}

function showTreatmentPlacementHint(productName) {
  const el = ensurePlacementHint();
  el.innerHTML =
    `<strong style="color:#fff;font-weight:600;">${escapeHintText(productName)}</strong>` +
    `<span style="color:#b9bfc8;"> — click a wall or the ceiling</span>` +
    `<span style="color:#8a929c;"> · Esc to cancel</span>`;
  // Initial position: hide off-screen until first pointermove inside canvas.
  el.style.left = '-9999px';
  el.style.top = '-9999px';
  el.style.opacity = '0';
  if (!_placementHintBound) {
    if (renderer) renderer.domElement.addEventListener('pointermove', _onPlacementHintMove);
    window.addEventListener('keydown', _onPlacementEscKey);
    _placementHintBound = true;
  }
}

function hideTreatmentPlacementHint() {
  if (_placementHintEl) {
    _placementHintEl.style.opacity = '0';
    _placementHintEl.style.left = '-9999px';
    _placementHintEl.style.top = '-9999px';
  }
  if (_placementHintBound) {
    if (renderer) renderer.domElement.removeEventListener('pointermove', _onPlacementHintMove);
    window.removeEventListener('keydown', _onPlacementEscKey);
    _placementHintBound = false;
  }
}

function _onPlacementHintMove(e) {
  if (!_placementHintEl) return;
  // Offset down-right of the cursor so the label doesn't cover what the
  // user is about to click. Clamp to viewport so it stays on-screen
  // when the cursor is near the right/bottom edge.
  const offsetX = 16, offsetY = 18;
  const w = _placementHintEl.offsetWidth || 220;
  const h = _placementHintEl.offsetHeight || 32;
  const vx = window.innerWidth, vy = window.innerHeight;
  let x = e.clientX + offsetX;
  let y = e.clientY + offsetY;
  if (x + w > vx - 4) x = e.clientX - w - 8;     // flip to the left
  if (y + h > vy - 4) y = e.clientY - h - 8;     // flip above
  _placementHintEl.style.left = `${x}px`;
  _placementHintEl.style.top = `${y}px`;
  _placementHintEl.style.opacity = '1';
}

function _onPlacementEscKey(e) {
  if (e.key !== 'Escape') return;
  if (!_pendingPlacementProductId) return;
  e.preventDefault();
  cancelTreatmentPlacement();
  try { emit('treatment:placement_cancelled'); } catch (_) {}
}

function escapeHintText(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export async function armTreatmentPlacement(productId) {
  if (!productId) return;
  // Resolve the spec; we may need to load the catalogue first.
  let spec = findCatalogueEntry(productId);
  if (!spec) {
    try {
      await loadSurfaceCatalogue();
      spec = findCatalogueEntry(productId);
    } catch (_) {}
  }
  if (!spec) {
    console.warn('[treatments] cannot place — productId not in catalogue:', productId);
    return;
  }
  _pendingPlacementProductId = productId;
  _pendingPlacementSpec = spec;
  if (renderer) renderer.domElement.style.cursor = 'crosshair';
  showTreatmentPlacementHint(spec.name || productId);
  // Show a hint via the scene's existing toast pattern (panel emits
  // treatment:placement_armed for any listener that cares).
  try { emit('treatment:placement_armed', { productId, spec }); } catch (_) {}
}

export function cancelTreatmentPlacement() {
  _pendingPlacementProductId = null;
  _pendingPlacementSpec = null;
  if (renderer) renderer.domElement.style.cursor = '';
  hideTreatmentPlacementHint();
}

// Called from onSurfaceClick (below) when placement is armed. Returns
// true if the click was consumed by placement (caller should skip its
// usual surface-selection path).
function _handlePlacementClick(roomHits) {
  if (!_pendingPlacementProductId || !_pendingPlacementSpec) return false;
  // Find the FIRST wall or ceiling hit. Skip heatmaps, zone overlays,
  // and any surface_id that isn't a wall/ceiling.
  let hit = null;
  let surface = null;
  for (const h of roomHits) {
    const tag = h.object.userData?.tag ?? '';
    if (tag.startsWith('heatmap_')) continue;
    if (h.object.userData?.zone_id) continue;
    const surfId = h.object.userData?.surface_id;
    if (!surfId) continue;
    if (surfId === 'ceiling') {
      surface = 'ceiling';
      hit = h;
      break;
    }
    // Anything starting with "wall_" (rectangular) or "edge_" (polygon)
    // counts as a wall hit. Sub-structure / enclosure walls are skipped
    // in v1 — treatments anchor to the OUTER room polygon only.
    if (surfId.startsWith('wall_') || surfId.startsWith('edge_')) {
      surface = 'wall';
      hit = h;
      break;
    }
  }
  if (!hit) return false;
  const polygonVerts = roomPlanVertices(state.room);
  let anchor, position;
  if (surface === 'ceiling') {
    anchor = { surface: 'ceiling' };
    position = {
      x: hit.point.x,
      y: hit.point.z,        // Three.js Z → state Y
      z: state.room.height_m ?? hit.point.y,
    };
  } else {
    // hit.point.x / .z = state X / Y; project onto nearest polygon edge.
    const worldXY = { x: hit.point.x, y: hit.point.z };
    const heightAbove = Math.max(0, hit.point.y); // state Z (elevation)
    const proj = projectOntoNearestWall(state.room, polygonVerts, worldXY, heightAbove);
    if (!proj) return false;
    anchor = { surface: 'wall', wallIndex: proj.wallIndex };
    position = proj.position;
  }
  const entry = makeTreatmentEntry(_pendingPlacementSpec, anchor, position, 0);
  state.treatments = state.treatments || [];
  state.treatments.push(entry);
  state.selectedTreatmentId = entry.id;
  cancelTreatmentPlacement();
  try {
    openPanel('left', 'treatments');
  } catch (_) {}
  emit('treatment:changed');
  return true;
}

// ---------------------------------------------------------------------------
// Treatment drag — pointerdown on a placed treatment, drag along the
// anchored surface plane. Wall anchors slide along the polygon edge;
// ceiling anchors slide in the X/Y plane at room height.
// ---------------------------------------------------------------------------
const _treatPickRay = new THREE.Raycaster();
const _treatPickNdc = { x: 0, y: 0 };
let _treatDrag = null;        // { id, surface, wallIndex?, pointerId, didMove }

function _findTreatmentFromHit(hit) {
  let o = hit?.object;
  while (o) {
    if (o.userData?.tag === 'treatment' && typeof o.userData?.treatmentId === 'string') return o;
    o = o.parent;
    if (!o || o === scene) break;
  }
  return null;
}

function onTreatmentPointerDown(e) {
  if (walkMode || probeActive) return;
  if (e.button !== 0) return;
  if (_pendingPlacementProductId) return;   // placement click takes priority
  if (!treatmentsGroup || treatmentsGroup.children.length === 0) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _treatPickNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _treatPickNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _treatPickRay.setFromCamera(_treatPickNdc, activeCamera || camera);
  const hits = _treatPickRay.intersectObject(treatmentsGroup, true);
  if (hits.length === 0) return;
  // Speaker priority — if a speaker is closer, bail and let the speaker
  // handler claim the click.
  const treatGroup = _findTreatmentFromHit(hits[0]);
  if (!treatGroup) return;
  if (sourcesGroup) {
    const sHits = _treatPickRay.intersectObject(sourcesGroup, true);
    for (const h of sHits) {
      if (h.object.userData?.speakerModelUrl && h.distance < hits[0].distance) return;
    }
  }
  const tid = treatGroup.userData.treatmentId;
  const t = state.treatments.find(x => x.id === tid);
  if (!t) return;
  e.preventDefault();
  e.stopPropagation();
  if (controls) controls.enabled = false;
  state.selectedTreatmentId = tid;
  _treatDrag = {
    id: tid,
    surface: t.anchor?.surface ?? 'wall',
    wallIndex: t.anchor?.wallIndex,
    pointerId: e.pointerId,
    didMove: false,
  };
  try { renderer.domElement.setPointerCapture(e.pointerId); } catch (_) {}
  renderer.domElement.addEventListener('pointermove', onTreatmentPointerMove);
  renderer.domElement.addEventListener('pointerup', onTreatmentPointerUp);
  renderer.domElement.addEventListener('pointercancel', onTreatmentPointerUp);
  // Mirror the speaker-click pattern: open the Treatments panel and
  // ask it to scroll + flash the matching card. treatment:selected
  // re-renders the panel; treatment:highlight scrolls the new card
  // into view AFTER the re-render flushes.
  try { openPanel('left', 'treatments'); } catch (_) {}
  emit('treatment:selected', { id: tid });
  emit('treatment:highlight', { id: tid });
}

function _raycastIntoSurfacePlane(e) {
  if (!_treatDrag) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  _treatPickNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _treatPickNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _treatPickRay.setFromCamera(_treatPickNdc, activeCamera || camera);
  // Intersect the live room geometry so we don't have to maintain a
  // separate planar mesh for the drag.
  if (!roomGroup) return null;
  const hits = _treatPickRay.intersectObject(roomGroup, true);
  if (_treatDrag.surface === 'ceiling') {
    // Take the ceiling hit (any surface_id === 'ceiling' or similar).
    for (const h of hits) {
      if (h.object.userData?.surface_id === 'ceiling') {
        return { worldXY: { x: h.point.x, y: h.point.z }, z: state.room.height_m ?? h.point.y };
      }
    }
    return null;
  }
  // Wall — take the first wall hit (any wall_* / edge_*). Project the
  // hit's XY onto the ANCHORED wall index so the panel can't hop walls
  // mid-drag.
  for (const h of hits) {
    const surfId = h.object.userData?.surface_id;
    if (!surfId) continue;
    if (!(surfId.startsWith('wall_') || surfId.startsWith('edge_') || surfId === 'walls')) continue;
    return { worldXY: { x: h.point.x, y: h.point.z }, z: Math.max(0, h.point.y) };
  }
  return null;
}

function onTreatmentPointerMove(e) {
  if (!_treatDrag) return;
  const t = state.treatments.find(x => x.id === _treatDrag.id);
  if (!t) return;
  const raw = _raycastIntoSurfacePlane(e);
  if (!raw) return;
  _treatDrag.didMove = true;
  if (_treatDrag.surface === 'ceiling') {
    t.position.x = raw.worldXY.x;
    t.position.y = raw.worldXY.y;
    t.position.z = raw.z;
  } else {
    // Constrain to the anchored wall edge.
    const polygonVerts = roomPlanVertices(state.room);
    const proj = projectOntoWall(polygonVerts, _treatDrag.wallIndex, raw.worldXY, raw.z);
    if (proj) {
      t.position.x = proj.position.x;
      t.position.y = proj.position.y;
      t.position.z = raw.z;
    }
  }
  emit('treatment:changed');
}

function onTreatmentPointerUp(e) {
  if (!_treatDrag) return;
  if (controls) controls.enabled = true;
  renderer.domElement.removeEventListener('pointermove', onTreatmentPointerMove);
  renderer.domElement.removeEventListener('pointerup', onTreatmentPointerUp);
  renderer.domElement.removeEventListener('pointercancel', onTreatmentPointerUp);
  try { renderer.domElement.releasePointerCapture(_treatDrag.pointerId); } catch (_) {}
  _treatDrag = null;
}

function rebuildZones() { shadowsNeedRefresh = true;
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
    // No zones — but the PREVIOUS scene may have left audience figures
    // behind. Dispose them explicitly so a zones-less preset (like
    // Pavilion Mall) shows up empty instead of inheriting the prior
    // arena crowd.
    rebuildAudience();
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
    rebuildAudience();
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
      const zoneSplOpts = currentPhysicsOpts(state.room);
      // STIPA mode: precompute the per-band RT60 / room-constant / source
      // L_w context once for this zone-rebuild pass and pass it into the
      // grid sampler so each cell gets STI in [0, 1] instead of SPL dB.
      // Without this branch the legacy zone-grid path always wrote SPL
      // values, and the legend (which switches title to "STI" by mode)
      // displayed dB values labelled as STI — the 83–96 bug.
      const useSTIz = state.display.heatmapMode === 'stipa';
      const stipaCtxZ = useSTIz
        ? precomputeSTIPAContext({
            sources: flatSources,
            getSpeakerDef: url => getCachedLoudspeaker(url),
            room: state.room, materials: materialsRef, zones: state.zones,
            treatments: state.treatments,
          })
        : null;
      splInfo = computeZoneSPLGrid({
        zone, sources: flatSources,
        getSpeakerDef: url => getCachedLoudspeaker(url),
        room: state.room, gridSize: adaptiveGrid, earAbove_m: 1.2,
        ...zoneSplOpts,
        metric: useSTIz ? 'sti' : 'spl',
        stipaCtx: stipaCtxZ,
        ambient_per_band: useSTIz ? state.physics.ambientNoise?.per_band : null,
        computeSTIPAAt: useSTIz ? computeSTIPAAt : null,
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
        map: heatmapTex, transparent: true, opacity: 0.95,
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
  rebuildAudience();
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

// Stepped rake — returns the elevation of the tier that contains radius r.
// A linear-interp rake sliced through the stepped concrete tiers producing
// orange/gray stripe artifacts on the seating. Sitting the mapping surface
// exactly on each tier's concrete top instead keeps every heatmap pixel
// above a real seat, so the color reads as "SPL here at this row" rather
// than "SPL on an invisible diagonal plane". With enough radial mesh cells
// (radialMax=80 below) the vertical risers between tiers render as sharp
// near-vertical segments, giving the staircase profile cleanly.
function rakeZAtRadius(r, bowl) {
  const tiers = bowl.tier_heights_m;
  if (r <= bowl.r_in) return tiers[0];
  if (r >= bowl.r_out) return tiers[tiers.length - 1];
  const tread = (bowl.r_out - bowl.r_in) / tiers.length;
  const t = Math.min(tiers.length - 1, Math.floor((r - bowl.r_in) / tread));
  return tiers[t];
}

// Builds an (radialCells+1) × (arcCells+1) grid of vertices across a ring
// sector. zFn(r) gives the world-Y height at each radius. Returns the
// BufferGeometry plus a parallel array of state-coord listener anchors so
// callers can sample SPL at each vertex.
// Grid dimensions are exposed on the returned geoPack so the isobar
// contour builder can do 2D marching squares on the vertex SPL values.
function buildRingSectorGeometry({ cx, cy, r_in, r_out, phiStart, phiLength, zFn, earAbove = 1.2, liftAbove = 0.05, cellTarget = 0.25, radialMin = 12, radialMax = 80, arcMin = 12, arcMax = 120 }) {
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
  // Grid dimensions for marching-squares contour extraction: arc = X, radial = Y.
  return { geo, listenerAnchors, gridW: arcCells + 1, gridH: radialCells + 1 };
}

// Axis-aligned rectangle grid (used for the court and for any future flat
// audience area). Same vertex-color convention as the ring-sector builder.
function buildRectMappingGeometry({ minX, maxX, minY, maxY, elevation, earAbove = 1.2, liftAbove = 0.05, cellTarget = 0.5 }) {
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
  // Grid dimensions for contours: x = nx+1, z = nz+1.
  return { geo, listenerAnchors, gridW: nz + 1, gridH: nx + 1 };
}

// Resolve the current physics flags from state.display.physics and compute
// the Hopkins-Stryker room constant R for the active band. Called at the
// top of each heatmap rebuild so R is computed ONCE per frame even though
// thousands of vertex samples use it.
function currentPhysicsOpts(room) {
  const phys = state.physics ?? {};
  const freq = phys.freq_hz ?? 1000;
  return {
    freq_hz: freq,
    airAbsorption: phys.airAbsorption !== false,
    coherent: !!phys.coherent,
    roomConstantR: phys.reverberantField && materialsRef
      ? computeRoomConstant(room, materialsRef, freq, state.zones, { treatments: state.treatments })
      : 0,
    // Master EQ gain at the current heatmap frequency. eqGainAt returns 0
    // when the EQ is bypassed so SPL / heatmap physics is identical to
    // before when eq.enabled === false.
    eqGainDb: eqGainAt(phys.eq, freq),
  };
}

// Fill the color BufferAttribute by sampling SPL at each vertex anchor.
// Returns min/max/avg/uniformity stats plus a Float32Array of the per-vertex
// SPL values so the isobar contour extractor can do marching-squares on the
// raw field without re-sampling.
function sampleSurfaceColors(geo, anchors, sources, room, splOpts = {}) {
  const colorAttr = geo.attributes.color;
  const getDef = url => getCachedLoudspeaker(url);
  const splValues = new Float32Array(anchors.length);
  let minSPL = Infinity, maxSPL = -Infinity, sum = 0, count = 0;

  // --- Hot-path precompute — Phase A2 Step 1. --------------------------
  // STIPA already has a precompute/computeAt split. SPL now matches:
  // resolve every speaker def, compute each source's L_w (with EQ gain)
  // at the current frequency, and stash `10·log10(4/R)` — all before
  // entering the per-vertex loop. On the arena heatmap (24 sources ×
  // ~10k vertices × reverb on) this eliminates ~240k Map.get() +
  // approxSoundPowerLevel calls per frame. ~15-20 % faster end-to-end.
  const useSTI = state.display.heatmapMode === 'stipa';
  const stipaCtx = useSTI
    ? precomputeSTIPAContext({ sources, getSpeakerDef: getDef, room, materials: materialsRef, zones: state.zones, treatments: state.treatments })
    : null;
  const splCtx = !useSTI
    ? precomputeSPLContext({
        sources, getSpeakerDef: getDef,
        freq_hz: splOpts.freq_hz ?? 1000,
        roomConstantR: splOpts.roomConstantR ?? 0,
        eqGainDb: splOpts.eqGainDb ?? 0,
      })
    : null;
  const splAtOpts = {
    room,
    coherent: splOpts.coherent,
    temperature_C: splOpts.temperature_C,
    airAbsorption: splOpts.airAbsorption,
  };

  const ambient_per_band = useSTI ? state.physics.ambientNoise?.per_band : null;
  for (let i = 0; i < anchors.length; i++) {
    let value;            // SPL in dB, or STI in [0,1]
    if (useSTI) {
      value = computeSTIPAAt(stipaCtx, anchors[i], ambient_per_band);
    } else {
      value = computeMultiSourceSPLFromContext(splCtx, anchors[i], splAtOpts);
    }
    splValues[i] = value;
    if (isFinite(value)) {
      if (value < minSPL) minSPL = value;
      if (value > maxSPL) maxSPL = value;
      sum += value; count++;
      const [r, g, b] = useSTI ? stiColorRGB(value) : splColorRGB(value);
      colorAttr.setXYZ(i, r / 255, g / 255, b / 255);
    } else {
      colorAttr.setXYZ(i, 0.12, 0.12, 0.14);
    }
  }
  colorAttr.needsUpdate = true;
  return {
    // Fields named *_db even though they carry STI when useSTI — keeps the
    // existing Results panel / legend code path working. Interpretation is
    // resolved by state.display.heatmapMode at display time.
    minSPL_db: count > 0 ? minSPL : 0,
    maxSPL_db: count > 0 ? maxSPL : 0,
    avgSPL_db: count > 0 ? sum / count : 0,
    uniformity_db: count > 0 ? maxSPL - minSPL : 0,
    count,
    splValues,
  };
}

// ---------------------------------------------------------------------------
// Isobar contour lines via marching squares. Given a regular 2D vertex grid
// (gridW × gridH) with per-vertex SPL values + world positions, extract
// contour polyline segments at each dB level and build a THREE.LineSegments
// mesh. Lines drape over the mapping surface (same underlying geometry), so
// they track the rake/step profile automatically. Ambiguous 2x2 cases use
// "connect majority" — rare enough at 0.25 m resolution to not matter.
//
// Pros use these to read -3 / -6 dB drop-off lines — the crucial feature
// that sets a real acoustic-simulator output apart from a pretty gradient.
// ---------------------------------------------------------------------------
const CONTOUR_CASES = {
  // code → pairs of edges to connect. Edges: 0=bottom 1=right 2=top 3=left.
  1: [3, 0], 2: [0, 1], 3: [3, 1], 4: [1, 2],
  5: [3, 0, 1, 2],   // saddle — draw both
  6: [0, 2], 7: [3, 2], 8: [2, 3], 9: [0, 2],
  10: [0, 1, 2, 3],  // saddle
  11: [1, 2], 12: [1, 3], 13: [0, 1], 14: [0, 3],
};

function buildContourLines(splValues, positions, gridW, gridH, levels, color = 0xffffff, opacity = 0.55) {
  const out = [];
  const posAt = (idx, arr) => { arr[0] = positions[idx * 3]; arr[1] = positions[idx * 3 + 1]; arr[2] = positions[idx * 3 + 2]; };
  const edge = new Array(4);
  for (let k = 0; k < 4; k++) edge[k] = new Float32Array(3);

  for (const level of levels) {
    for (let j = 0; j < gridH - 1; j++) {
      for (let i = 0; i < gridW - 1; i++) {
        const iBL = j * gridW + i;
        const iBR = iBL + 1;
        const iTL = iBL + gridW;
        const iTR = iTL + 1;
        const vBL = splValues[iBL];
        const vBR = splValues[iBR];
        const vTL = splValues[iTL];
        const vTR = splValues[iTR];
        if (!isFinite(vBL) || !isFinite(vBR) || !isFinite(vTL) || !isFinite(vTR)) continue;

        let code = 0;
        if (vBL >= level) code |= 1;
        if (vBR >= level) code |= 2;
        if (vTR >= level) code |= 4;
        if (vTL >= level) code |= 8;
        if (code === 0 || code === 15) continue;

        // Linearly interpolate edge crossings — share a small Float32Array
        // per edge to avoid per-cell allocation.
        const pBL = [0,0,0], pBR = [0,0,0], pTL = [0,0,0], pTR = [0,0,0];
        posAt(iBL, pBL); posAt(iBR, pBR); posAt(iTL, pTL); posAt(iTR, pTR);
        if ((vBL < level) !== (vBR < level)) {
          const t = (level - vBL) / (vBR - vBL);
          edge[0][0] = pBL[0] + (pBR[0] - pBL[0]) * t;
          edge[0][1] = pBL[1] + (pBR[1] - pBL[1]) * t;
          edge[0][2] = pBL[2] + (pBR[2] - pBL[2]) * t;
        }
        if ((vBR < level) !== (vTR < level)) {
          const t = (level - vBR) / (vTR - vBR);
          edge[1][0] = pBR[0] + (pTR[0] - pBR[0]) * t;
          edge[1][1] = pBR[1] + (pTR[1] - pBR[1]) * t;
          edge[1][2] = pBR[2] + (pTR[2] - pBR[2]) * t;
        }
        if ((vTL < level) !== (vTR < level)) {
          const t = (level - vTL) / (vTR - vTL);
          edge[2][0] = pTL[0] + (pTR[0] - pTL[0]) * t;
          edge[2][1] = pTL[1] + (pTR[1] - pTL[1]) * t;
          edge[2][2] = pTL[2] + (pTR[2] - pTL[2]) * t;
        }
        if ((vBL < level) !== (vTL < level)) {
          const t = (level - vBL) / (vTL - vBL);
          edge[3][0] = pBL[0] + (pTL[0] - pBL[0]) * t;
          edge[3][1] = pBL[1] + (pTL[1] - pBL[1]) * t;
          edge[3][2] = pBL[2] + (pTL[2] - pBL[2]) * t;
        }

        const pairs = CONTOUR_CASES[code] || [];
        for (let p = 0; p < pairs.length; p += 2) {
          const a = edge[pairs[p]], b = edge[pairs[p + 1]];
          out.push(a[0], a[1] + 0.01, a[2], b[0], b[1] + 0.01, b[2]);
        }
      }
    }
  }

  if (out.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const mesh = new THREE.LineSegments(geo, mat);
  mesh.renderOrder = 900;
  mesh.userData.tag = 'heatmap_contour';
  return mesh;
}

// One MeshBasicMaterial shared across every mapping surface — keeps GPU state
// changes low and makes toggle visibility flip cheap.
function makeMappingMaterial() {
  return new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.78,
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
  const fallbackLabels = sorted.length === 4 ? ['SE', 'SW', 'NW', 'NE'] : sorted.map((_, i) => `S${i+1}`);
  const material = makeMappingMaterial();
  const splOpts = currentPhysicsOpts(room);

  for (let i = 0; i < sorted.length; i++) {
    const curCenter = sorted[i];
    const nextCenter = sorted[(i + 1) % sorted.length];
    const sectorStart = curCenter + halfWidthRad;
    let sectorEnd = nextCenter - halfWidthRad;
    if (sectorEnd <= sectorStart) sectorEnd += Math.PI * 2;
    const sectorLength = sectorEnd - sectorStart;
    const label = fallbackLabels[i];

    const addSurface = ({ geoPack, id, surfaceLabel, elev }) => {
      const stats = sampleSurfaceColors(geoPack.geo, geoPack.listenerAnchors, sources, room, splOpts);
      const mesh = new THREE.Mesh(geoPack.geo, material);
      mesh.userData.tag = id;
      mesh.userData.acoustic_material = 'concrete';
      heatmapGroup.add(mesh);
      // Isobars — extract contour lines at every isobarStep_db interval across
      // the min..max SPL range of this surface. Lines live in heatmapGroup so
      // they follow the surface toggle.
      if (state.display.showIsobars && stats.count > 0) {
        const step = state.display.isobarStep_db ?? 3;
        const lo = Math.ceil(stats.minSPL_db / step) * step;
        const hi = Math.floor(stats.maxSPL_db / step) * step;
        const levels = [];
        for (let L = lo; L <= hi; L += step) levels.push(L);
        const positions = geoPack.geo.attributes.position.array;
        const contours = buildContourLines(stats.splValues, positions, geoPack.gridW, geoPack.gridH, levels);
        if (contours) heatmapGroup.add(contours);
      }
      state.results.zoneGrids.push({
        id, label: surfaceLabel,
        elevation_m: elev, earZ_m: elev + 1.2,
        grid: [], cellsX: 0, cellsY: 0, boundsX: [0,0], boundsY: [0,0],
        cellW_m: 0, cellH_m: 0,
        metric: state.display.heatmapMode === 'stipa' ? 'sti' : 'spl',
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
    const stats = sampleSurfaceColors(pack.geo, pack.listenerAnchors, sources, room, splOpts);
    const mesh = new THREE.Mesh(pack.geo, material);
    mesh.userData.tag = 'heatmap_court';
    mesh.userData.acoustic_material = courtZone.material_id ?? null;
    heatmapGroup.add(mesh);
    // Court isobars too.
    if (state.display.showIsobars && stats.count > 0) {
      const step = state.display.isobarStep_db ?? 3;
      const lo = Math.ceil(stats.minSPL_db / step) * step;
      const hi = Math.floor(stats.maxSPL_db / step) * step;
      const levels = [];
      for (let L = lo; L <= hi; L += step) levels.push(L);
      const positions = pack.geo.attributes.position.array;
      const contours = buildContourLines(stats.splValues, positions, pack.gridW, pack.gridH, levels);
      if (contours) heatmapGroup.add(contours);
    }
    state.results.zoneGrids.push({
      id: courtZone.id, label: courtZone.label ?? 'Court',
      elevation_m: courtZone.elevation_m ?? 0,
      earZ_m: (courtZone.elevation_m ?? 0) + 1.2,
      grid: [], cellsX: 0, cellsY: 0, boundsX: [0,0], boundsY: [0,0],
      cellW_m: 0, cellH_m: 0,
      metric: state.display.heatmapMode === 'stipa' ? 'sti' : 'spl',
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
// Multi-level shopping-mall architecture. Renders N floor slabs (with an
// atrium cutout punched through every slab), a grid of structural columns
// running the full building height, and escalator ramps between levels.
// Driven by room.multiLevelStructure — built for the Pavilion 2 preset.
function rebuildMultiLevelStructure(room) {
  const mls = room.multiLevelStructure;
  if (!mls) return;

  const concreteMat = new THREE.MeshStandardMaterial({
    color: 0x9a9c9f, roughness: 0.82, metalness: 0.03,
    side: THREE.DoubleSide,
  });
  const slabEdgeMat = new THREE.MeshStandardMaterial({
    color: 0x7e8286, roughness: 0.78, metalness: 0.05,
  });
  const escalatorMat = new THREE.MeshStandardMaterial({
    color: 0x34393f, roughness: 0.4, metalness: 0.85,
  });
  const escalatorStepMat = new THREE.MeshStandardMaterial({
    color: 0x52575e, roughness: 0.55, metalness: 0.75,
  });
  const railingMat = new THREE.MeshStandardMaterial({
    color: 0x2b2e34, roughness: 0.35, metalness: 0.9,
  });
  const glassRailMat = new THREE.MeshStandardMaterial({
    color: 0xaaccff, roughness: 0.1, metalness: 0.2,
    transparent: true, opacity: 0.18,
    side: THREE.DoubleSide,
  });

  // -------- Build the 2D Shape for a footprint−atrium cross-section ---
  // THREE.ExtrudeGeometry's triangulator handles hole winding internally,
  // so we just push every hole onto `shape.holes` and let the built-in
  // earcut sort it out. (An earlier revision ran an explicit
  // isClockWise / curves.reverse() pass — that sealed the atrium in
  // every slab because reversing the curves array left each curve's
  // v1→v2 direction untouched, producing a malformed hole path.)
  function buildFootprintShape(footprint, atrium, extraHoles) {
    const shape = new THREE.Shape();
    shape.moveTo(footprint[0].x, footprint[0].y);
    for (let i = 1; i < footprint.length; i++) {
      shape.lineTo(footprint[i].x, footprint[i].y);
    }
    shape.closePath();
    const pushHole = (pts) => {
      if (!pts || pts.length < 3) return;
      const path = new THREE.Path();
      path.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
      path.closePath();
      shape.holes.push(path);
    };
    if (atrium && atrium.length >= 3) pushHole(atrium);
    if (extraHoles) for (const h of extraHoles) pushHole(h);
    return shape;
  }

  // -------- Floor slabs (one per level above the ground) --------------
  for (const lv of (mls.levels || [])) {
    // Escalator landings get a square hole in the slab above them so
    // the escalator's top step isn't sealed by the ceiling. Hole
    // applies to the slab at `to_level` (the floor the rider is
    // stepping onto).
    const extraHoles = (mls.escalatorOpenings || [])
      .filter(o => o.slab_level === lv.index)
      .map(o => [
        { x: o.x1, y: o.y1 }, { x: o.x2, y: o.y1 },
        { x: o.x2, y: o.y2 }, { x: o.x1, y: o.y2 },
      ]);
    const shape = buildFootprintShape(mls.footprint, mls.atrium, extraHoles);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: lv.thickness_m ?? 0.4,
      bevelEnabled: false,
      steps: 1,
    });
    // Shape is authored in (x, y) with +y = world depth. Rotating the
    // geometry by +π/2 around X maps shape's (x, y) → world (x, y_world = 0, z_world = y) and extrusion direction → downward (-Y world). Position the
    // mesh at slab_z, top-of-slab — extrusion then hangs the slab
    // below that, matching "slab_z is the floor of the level above."
    geo.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, concreteMat);
    mesh.position.y = lv.slab_z;
    mesh.userData.acoustic_material = 'concrete';
    mesh.userData.tag = `slab_level_${lv.index}`;
    roomGroup.add(mesh);

    // Glass guardrail ring around the atrium opening at this level — a
    // ribbon of translucent glass 1.1 m tall above the slab top.
    if (mls.atrium && mls.atrium.length >= 3) {
      const railH = 1.1;
      for (let i = 0; i < mls.atrium.length; i++) {
        const a = mls.atrium[i];
        const b = mls.atrium[(i + 1) % mls.atrium.length];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        const segGeo = new THREE.BoxGeometry(len, railH, 0.02);
        const seg = new THREE.Mesh(segGeo, glassRailMat);
        seg.position.set((a.x + b.x) / 2, lv.slab_z + railH / 2, (a.y + b.y) / 2);
        seg.rotation.y = -Math.atan2(dy, dx);
        seg.userData.acoustic_material = 'glass';
        seg.userData.tag = `atrium_rail_${lv.index}`;
        roomGroup.add(seg);
        // Top handrail chrome bar
        const topRail = new THREE.Mesh(
          new THREE.BoxGeometry(len, 0.05, 0.08),
          railingMat,
        );
        topRail.position.set((a.x + b.x) / 2, lv.slab_z + railH + 0.03, (a.y + b.y) / 2);
        topRail.rotation.y = -Math.atan2(dy, dx);
        roomGroup.add(topRail);
      }
    }
  }

  // -------- Structural columns (full-height cylinders) ---------------
  const colSegments = 16;
  for (const col of (mls.columns || [])) {
    const h = (col.top_z ?? 0) - (col.base_z ?? 0);
    if (h <= 0) continue;
    const geo = new THREE.CylinderGeometry(col.radius_m, col.radius_m, h, colSegments);
    const mesh = new THREE.Mesh(geo, concreteMat);
    mesh.position.set(col.x, (col.base_z + col.top_z) / 2, col.y);
    mesh.userData.acoustic_material = 'concrete';
    mesh.userData.tag = 'column';
    roomGroup.add(mesh);
    // Capital — square plate on top, visual detail
    const capH = 0.15;
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(col.radius_m * 2.2, capH, col.radius_m * 2.2),
      slabEdgeMat,
    );
    cap.position.set(col.x, col.top_z - capH / 2 - 0.02, col.y);
    roomGroup.add(cap);
  }

  // -------- Escalator ramps (angled steel boxes) ---------------------
  for (const esc of (mls.escalators || [])) {
    const dx = esc.top.x - esc.base.x;
    const dy = esc.top.y - esc.base.y;
    const dz = (esc.top_z ?? 0) - (esc.base_z ?? 0);
    const horizLen = Math.hypot(dx, dy);
    const totalLen = Math.hypot(horizLen, dz);
    if (totalLen < 0.1) continue;
    const width = esc.width_m ?? 1.2;
    // Ramp body — long box along the incline.
    const rampGeo = new THREE.BoxGeometry(totalLen, 0.25, width);
    const ramp = new THREE.Mesh(rampGeo, escalatorMat);
    const midX = (esc.base.x + esc.top.x) / 2;
    const midY = (esc.base.y + esc.top.y) / 2;
    const midZ = (esc.base_z + esc.top_z) / 2;
    ramp.position.set(midX, midZ, midY);
    // Orient: the box's long axis runs from base to top. Compute
    // yaw (around Y) and pitch (around local Z after the yaw) so the
    // long axis points from base to top.
    const yaw = Math.atan2(-dy, dx);       // world y is depth → negate for Three.js
    const pitch = Math.atan2(dz, horizLen);
    ramp.rotation.set(0, yaw, pitch);
    ramp.userData.acoustic_material = 'steel';
    ramp.userData.tag = 'escalator';
    roomGroup.add(ramp);

    // Step treads on the incline — a row of small dark boxes to hint
    // at the moving-stair texture.
    const nSteps = Math.max(4, Math.floor(totalLen / 0.4));
    for (let s = 0; s < nSteps; s++) {
      const t = (s + 0.5) / nSteps;
      const step = new THREE.Mesh(
        new THREE.BoxGeometry(totalLen / nSteps * 0.85, 0.06, width * 0.9),
        escalatorStepMat,
      );
      step.position.set(
        esc.base.x + dx * t,
        esc.base_z + dz * t + 0.14,
        esc.base.y + dy * t,
      );
      step.rotation.set(0, yaw, pitch);
      roomGroup.add(step);
    }

    // Hand rails on each side of the escalator — chromed bars.
    const railYOff = width / 2 + 0.04;
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(totalLen, 0.06, 0.04),
        railingMat,
      );
      rail.position.set(
        midX + Math.sin(yaw) * side * railYOff,
        midZ + 0.55,
        midY + Math.cos(yaw) * side * railYOff,
      );
      rail.rotation.set(0, yaw, pitch);
      roomGroup.add(rail);
    }
  }

  // -------- Shop bays along each level's perimeter -------------------
  // Per-shop: two side dividers (gypsum), a storefront glass panel on
  // the front edge with a shutter opening cut out, and a brand sign
  // above the shutter. Materials tagged for the precision ray tracer
  // via userData.acoustic_material — gypsum + glass have very
  // different absorption coefficients so the mall's RT60 reads right.
  const gypsumMat = new THREE.MeshStandardMaterial({
    color: 0xf3f0ea, roughness: 0.88, metalness: 0.0,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xb9d4e6, roughness: 0.08, metalness: 0.05,
    transparent: true, opacity: 0.32, side: THREE.DoubleSide,
  });
  const signBackingMat = new THREE.MeshStandardMaterial({
    color: 0x1a1d22, roughness: 0.55, metalness: 0.25,
  });

  const DIVIDER_T = 0.1;      // 100 mm stud wall
  const GLASS_T = 0.04;       // 40 mm tempered storefront glass
  const SIGN_H = 0.9;         // 900 mm tall brand sign band
  const WALL_H = 5.4;         // 5.8 − 0.4 slab thickness

  for (const shop of (mls.shops || [])) {
    const lvZ = shop.level * 5.8;
    const wallBottom = lvZ + 0.01;
    const wallTop = lvZ + WALL_H;
    const wallMidZ = (wallBottom + wallTop) / 2;
    const wallCenterH = WALL_H;

    // Side dividers — two short walls perpendicular to the front edge.
    // For south/north strips they run along +y; for east/west along +x.
    const isHoriz = shop.side === 'south' || shop.side === 'north';
    const divDepth = shop.y2 - shop.y1;   // depth along Y for N/S shops
    const divWidth = shop.x2 - shop.x1;   // width along X
    if (isHoriz) {
      // Side dividers at x=shop.x1 and shop.x2, extending the full bay depth
      for (const xPos of [shop.x1, shop.x2]) {
        const div = new THREE.Mesh(
          new THREE.BoxGeometry(DIVIDER_T, wallCenterH, divDepth),
          gypsumMat,
        );
        div.position.set(xPos, wallMidZ, (shop.y1 + shop.y2) / 2);
        div.userData.acoustic_material = 'gypsum-board';
        div.userData.tag = 'shop_divider';
        roomGroup.add(div);
      }
    } else {
      // Side dividers at y=shop.y1 and shop.y2, full bay width
      for (const yPos of [shop.y1, shop.y2]) {
        const div = new THREE.Mesh(
          new THREE.BoxGeometry(divWidth, wallCenterH, DIVIDER_T),
          gypsumMat,
        );
        div.position.set((shop.x1 + shop.x2) / 2, wallMidZ, yPos);
        div.userData.acoustic_material = 'gypsum-board';
        div.userData.tag = 'shop_divider';
        roomGroup.add(div);
      }
    }

    // Storefront glass with a shutter opening. Split into two glass
    // panels flanking the shutter; the shutter itself is an open gap.
    const frontY = shop.side === 'south' ? shop.y2
                   : shop.side === 'north' ? shop.y1
                   : null;
    const frontX = shop.side === 'west' ? shop.x2
                   : shop.side === 'east' ? shop.x1
                   : null;
    const shutS = shop.shutter_start;
    const shutE = shutS + shop.shutter_width;
    const glassHeight = WALL_H - SIGN_H;
    const glassMidZ = lvZ + glassHeight / 2 + 0.01;

    if (isHoriz) {
      // Left glass panel: from shop.x1 → shutS
      const leftW = Math.max(0, shutS - shop.x1);
      if (leftW > 0.01) {
        const g = new THREE.Mesh(
          new THREE.BoxGeometry(leftW, glassHeight, GLASS_T),
          glassMat,
        );
        g.position.set((shop.x1 + shutS) / 2, glassMidZ, frontY);
        g.userData.acoustic_material = 'glass';
        g.userData.tag = 'shop_storefront';
        roomGroup.add(g);
      }
      // Right glass panel: shutE → shop.x2
      const rightW = Math.max(0, shop.x2 - shutE);
      if (rightW > 0.01) {
        const g = new THREE.Mesh(
          new THREE.BoxGeometry(rightW, glassHeight, GLASS_T),
          glassMat,
        );
        g.position.set((shutE + shop.x2) / 2, glassMidZ, frontY);
        g.userData.acoustic_material = 'glass';
        g.userData.tag = 'shop_storefront';
        roomGroup.add(g);
      }
    } else {
      const leftW = Math.max(0, shutS - shop.y1);
      if (leftW > 0.01) {
        const g = new THREE.Mesh(
          new THREE.BoxGeometry(GLASS_T, glassHeight, leftW),
          glassMat,
        );
        g.position.set(frontX, glassMidZ, (shop.y1 + shutS) / 2);
        g.userData.acoustic_material = 'glass';
        g.userData.tag = 'shop_storefront';
        roomGroup.add(g);
      }
      const rightW = Math.max(0, shop.y2 - shutE);
      if (rightW > 0.01) {
        const g = new THREE.Mesh(
          new THREE.BoxGeometry(GLASS_T, glassHeight, rightW),
          glassMat,
        );
        g.position.set(frontX, glassMidZ, (shutE + shop.y2) / 2);
        g.userData.acoustic_material = 'glass';
        g.userData.tag = 'shop_storefront';
        roomGroup.add(g);
      }
    }

    // Brand sign band above the storefront — dark backing box with a
    // canvas texture plane on the front face for the brand name.
    const signMidZ = lvZ + glassHeight + SIGN_H / 2 + 0.01;
    const signFullW = isHoriz ? divWidth : divWidth;
    const signFullD = isHoriz ? 0.08 : 0.08;
    if (isHoriz) {
      const back = new THREE.Mesh(
        new THREE.BoxGeometry(divWidth, SIGN_H, signFullD),
        signBackingMat,
      );
      back.position.set((shop.x1 + shop.x2) / 2, signMidZ, frontY);
      back.userData.acoustic_material = 'gypsum-board';
      back.userData.tag = 'shop_sign';
      roomGroup.add(back);
      const tex = getShopBrandTexture(shop.brand);
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(divWidth * 0.92, SIGN_H * 0.78),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
      );
      const frontOffset = (shop.side === 'south' ? 1 : -1) * (signFullD / 2 + 0.002);
      sign.position.set((shop.x1 + shop.x2) / 2, signMidZ, frontY + frontOffset);
      sign.rotation.y = shop.side === 'south' ? 0 : Math.PI;
      roomGroup.add(sign);
    } else {
      const back = new THREE.Mesh(
        new THREE.BoxGeometry(signFullD, SIGN_H, divWidth),
        signBackingMat,
      );
      back.position.set(frontX, signMidZ, (shop.y1 + shop.y2) / 2);
      back.userData.acoustic_material = 'gypsum-board';
      back.userData.tag = 'shop_sign';
      roomGroup.add(back);
      const tex = getShopBrandTexture(shop.brand);
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(divWidth * 0.92, SIGN_H * 0.78),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
      );
      const frontOffset = (shop.side === 'west' ? 1 : -1) * (signFullD / 2 + 0.002);
      sign.position.set(frontX + frontOffset, signMidZ, (shop.y1 + shop.y2) / 2);
      sign.rotation.y = shop.side === 'west' ? Math.PI / 2 : -Math.PI / 2;
      roomGroup.add(sign);
    }
  }

  // -------- Mall fixtures: toilets, lifts, fire stairs, etc. --------
  // Each item becomes a simple volumetric enclosure — 4 walls + floor
  // + ceiling for toilets, glass shaft for lifts, concrete shaft for
  // fire stairs. Materials tagged for the ray tracer; RT60 accounting
  // sees these as interior absorptive volumes once the physics layer
  // reads them.
  const tileCeilMat = new THREE.MeshStandardMaterial({
    color: 0xeaeae2, roughness: 0.82, metalness: 0.0,
  });
  const concreteMat2 = new THREE.MeshStandardMaterial({
    color: 0x9a9ca0, roughness: 0.85, metalness: 0.02,
  });
  const tallGlassMat = new THREE.MeshStandardMaterial({
    color: 0xc9dce8, roughness: 0.1, metalness: 0.08,
    transparent: true, opacity: 0.22, side: THREE.DoubleSide,
  });

  const WALL_T = 0.10;
  const CEIL_T = 0.05;
  const FIX_WALL_H = 5.4;   // levelHeight − slabThickness

  // Toilet blocks — 4 walls + floor + ceiling per block.
  for (const t of (mls.toiletBlocks || [])) {
    const z0 = t.level * 5.8 + 0.01;
    const z1 = z0 + FIX_WALL_H;
    const zMid = (z0 + z1) / 2;
    const w = t.x2 - t.x1, d = t.y2 - t.y1;
    const cx = (t.x1 + t.x2) / 2, cy = (t.y1 + t.y2) / 2;
    // 4 walls (gypsum)
    const walls = [
      { sx: w, sz: WALL_T, px: cx, py: t.y1 },   // south
      { sx: w, sz: WALL_T, px: cx, py: t.y2 },   // north
      { sx: WALL_T, sz: d, px: t.x1, py: cy },   // west
      { sx: WALL_T, sz: d, px: t.x2, py: cy },   // east
    ];
    for (const wall of walls) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(wall.sx, FIX_WALL_H, wall.sz),
        gypsumMat,
      );
      m.position.set(wall.px, zMid, wall.py);
      m.userData.acoustic_material = 'gypsum-board';
      m.userData.tag = `toilet_wall_L${t.level}`;
      roomGroup.add(m);
    }
    // Ceiling (acoustic-tile)
    const ceil = new THREE.Mesh(
      new THREE.BoxGeometry(w, CEIL_T, d),
      tileCeilMat,
    );
    ceil.position.set(cx, z1 - CEIL_T / 2, cy);
    ceil.userData.acoustic_material = 'acoustic-tile';
    ceil.userData.tag = `toilet_ceiling_L${t.level}`;
    roomGroup.add(ceil);
  }

  // Passenger lift shafts — full-height glass boxes at the atrium corners.
  for (const lift of (mls.passengerLifts || [])) {
    const w = lift.x2 - lift.x1, d = lift.y2 - lift.y1;
    const cx = (lift.x1 + lift.x2) / 2, cy = (lift.y1 + lift.y2) / 2;
    const zMid = ((lift.base_z ?? 0) + (lift.top_z ?? totalHeight)) / 2;
    const h = (lift.top_z ?? totalHeight) - (lift.base_z ?? 0);
    // Glass shaft — 4 thin panes (box geometry so the precision ray
    // tracer sees both sides as reflecting).
    const panes = [
      { sx: w, sz: 0.04, px: cx, py: lift.y1 },
      { sx: w, sz: 0.04, px: cx, py: lift.y2 },
      { sx: 0.04, sz: d, px: lift.x1, py: cy },
      { sx: 0.04, sz: d, px: lift.x2, py: cy },
    ];
    for (const pane of panes) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(pane.sx, h, pane.sz),
        tallGlassMat,
      );
      m.position.set(pane.px, zMid, pane.py);
      m.userData.acoustic_material = 'glass';
      m.userData.tag = 'passenger_lift_shaft';
      roomGroup.add(m);
    }
    // Simple cab hint — a small dark floor at mid-height.
    const cab = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.85, 0.1, d * 0.85),
      new THREE.MeshStandardMaterial({ color: 0x2a2d34, roughness: 0.4, metalness: 0.7 }),
    );
    cab.position.set(cx, (lift.base_z ?? 0) + 2.0, cy);
    roomGroup.add(cab);
  }

  // Fire stair enclosures — full-height concrete boxes at the 4 corners.
  for (const stair of (mls.fireStairs || [])) {
    const w = stair.x2 - stair.x1, d = stair.y2 - stair.y1;
    const cx = (stair.x1 + stair.x2) / 2, cy = (stair.y1 + stair.y2) / 2;
    const zMid = ((stair.base_z ?? 0) + (stair.top_z ?? totalHeight)) / 2;
    const h = (stair.top_z ?? totalHeight) - (stair.base_z ?? 0);
    const walls = [
      { sx: w, sz: WALL_T, px: cx, py: stair.y1 },
      { sx: w, sz: WALL_T, px: cx, py: stair.y2 },
      { sx: WALL_T, sz: d, px: stair.x1, py: cy },
      { sx: WALL_T, sz: d, px: stair.x2, py: cy },
    ];
    for (const wall of walls) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(wall.sx, h, wall.sz),
        concreteMat2,
      );
      m.position.set(wall.px, zMid, wall.py);
      m.userData.acoustic_material = 'concrete';
      m.userData.tag = 'fire_stair';
      roomGroup.add(m);
    }
  }

  // Emergency outdoor staircase — cantilevered slab strip along the
  // east facade, one per half-level. Box geometry with a diagonal
  // step-pattern hint; no enclosure (it's exterior).
  for (const esc of (mls.emergencyStairs || [])) {
    const xOuter = esc.x_outer ?? 80;
    const y1 = esc.y1, y2 = esc.y2;
    const d = y2 - y1;
    const nFlights = Math.round(((esc.top_z ?? totalHeight) - (esc.base_z ?? 0)) / 5.8 * 2);
    for (let f = 0; f < nFlights; f++) {
      const flightZ = (esc.base_z ?? 0) + f * 2.9 + 1.0;
      const flight = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 0.15, d * 0.9),
        concreteMat2,
      );
      flight.position.set(xOuter + 1.0, flightZ, (y1 + y2) / 2);
      flight.userData.acoustic_material = 'concrete';
      flight.userData.tag = 'emergency_stair';
      roomGroup.add(flight);
    }
    // Handrail on outer edge
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, (esc.top_z ?? totalHeight) - (esc.base_z ?? 0), d),
      new THREE.MeshStandardMaterial({ color: 0x2b2e34, roughness: 0.4, metalness: 0.85 }),
    );
    rail.position.set(xOuter + 1.8, ((esc.base_z ?? 0) + (esc.top_z ?? totalHeight)) / 2, (y1 + y2) / 2);
    roomGroup.add(rail);
  }

  // Food court — on L3 (top floor), a carpeted hall with a soft-
  // coloured floor overlay that reads "seating area" vs the regular
  // concrete concourse. Chairs / tables are left to the audience-
  // zone instanced humans (higher occupancy on this zone).
  const fc = mls.foodCourt;
  if (fc) {
    const z = fc.level * 5.8 + 0.015;
    const carpet = new THREE.Mesh(
      new THREE.BoxGeometry(fc.x2 - fc.x1, 0.02, fc.y2 - fc.y1),
      new THREE.MeshStandardMaterial({ color: 0x7c3f20, roughness: 0.95, metalness: 0.0 }),
    );
    carpet.position.set((fc.x1 + fc.x2) / 2, z, (fc.y1 + fc.y2) / 2);
    carpet.userData.acoustic_material = 'carpet-heavy';
    carpet.userData.tag = 'food_court_carpet';
    roomGroup.add(carpet);
  }
}

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

  // Center-hung 4-sided LED video board. Dark panel body with emissive LED
  // sides so it reads as "screens" at any lighting level. Hung from the
  // catwalk above it via 4 short cables.
  const sb = s.scoreboard;
  if (sb) {
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a, metalness: 0.4, roughness: 0.55,
    });
    // LED faces show the Amperes logo (branding). Canvas-drawn so no
    // external asset round-trip; same texture is mapped to all 4 sides.
    // map = albedo so the logo reads under any lighting; emissiveMap =
    // same canvas so the lit pixels also glow under the bloom pass.
    const logoTex = getAmperesLogoTexture();
    const ledMat = new THREE.MeshStandardMaterial({
      map: logoTex,
      emissiveMap: logoTex,
      emissive: 0xffffff,
      emissiveIntensity: 0.9,
      metalness: 0.2, roughness: 0.35,
    });
    const scoreboard = new THREE.Group();
    // Core box (top + bottom show as body, sides show as LED faces — use
    // an array of materials per face: +x,-x,+y,-y,+z,-z order).
    const boxGeo = new THREE.BoxGeometry(sb.width_m, sb.height_m, sb.width_m);
    const faceMats = [ledMat, ledMat, bodyMat, bodyMat, ledMat, ledMat];
    const box = new THREE.Mesh(boxGeo, faceMats);
    box.position.set(0, 0, 0);
    box.userData.acoustic_material = sb.material_id ?? 'led-glass';
    box.userData.tag = 'scoreboard_box';
    scoreboard.add(box);
    // 4 short hanger cables from box-top corners up to catwalk underside
    const topY = sb.height_m / 2;
    const catY = catwalkHeight - sb.center_z_m;   // in group-local coords
    for (const [dx, dz] of [[-1,-1],[1,-1],[-1,1],[1,1]]) {
      const hx = dx * sb.width_m / 2;
      const hz = dz * sb.width_m / 2;
      const pts = [new THREE.Vector3(hx, topY, hz), new THREE.Vector3(hx * 0.4, catY, hz * 0.4)];
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), cableMat);
      line.userData.acoustic_material = 'steel';
      scoreboard.add(line);
    }
    scoreboard.position.set(sb.cx, sb.center_z_m, sb.cy);
    zonesGroup.add(scoreboard);
  }
}

let _amperesLogoTex = null;
function getAmperesLogoTexture() {
  if (_amperesLogoTex) return _amperesLogoTex;
  const tex = new THREE.TextureLoader().load('assets/amperes-logo.png');
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  _amperesLogoTex = tex;
  return tex;
}

// Small "amperes" wordmark rendered as a canvas texture — looks like an
// embossed molding plate on the speaker body (brand-red text with a
// dark lower shadow + light upper highlight for the 3D embossed cue).
// Used on ceiling-speaker grilles, separate from the full-logo PNG
// (which lives on the arena scoreboard).
// Per-brand canvas-texture cache for mall storefront signs. One
// CanvasTexture per unique brand name; shared across every shop
// showing that brand. The sign reads as a retail facade plate —
// dark backing with the brand word in a bright accent colour.
const _shopBrandTexCache = new Map();
function getShopBrandTexture(brand) {
  if (_shopBrandTexCache.has(brand)) return _shopBrandTexCache.get(brand);
  const W = 512, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  // Dark translucent backing painted into the texture so the sign reads
  // against any wall colour behind it.
  ctx.fillStyle = 'rgba(15, 18, 24, 0.92)';
  ctx.fillRect(0, 0, W, H);
  // Accent-colour brand word. Pick a deterministic warm-tone per brand
  // so the concourse looks varied without being random on every reload.
  const hash = [...brand].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);
  const hues = ['#ffcc5a', '#ff6b6b', '#74d0ff', '#a3d977', '#f07bd6', '#ffa95a', '#b08bff'];
  const color = hues[Math.abs(hash) % hues.length];
  const fontSize = brand.length > 12 ? 44 : 64;
  ctx.font = `bold ${fontSize}px "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Slight embossed effect.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillText(brand, W / 2 + 2, H / 2 + 2);
  ctx.fillStyle = color;
  ctx.fillText(brand, W / 2, H / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  _shopBrandTexCache.set(brand, tex);
  return tex;
}

let _amperesTextTex = null;
function getAmperesTextTexture() {
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
  // Lower dark shadow (embossed depth)
  ctx.fillStyle = 'rgba(60, 40, 0, 0.60)';
  ctx.fillText('amperes', cx + 3, cy + 3);
  // Upper light highlight (embossed lift)
  ctx.fillStyle = 'rgba(255, 245, 200, 0.70)';
  ctx.fillText('amperes', cx - 2, cy - 2);
  // Main body — gold wordmark.
  ctx.fillStyle = '#D4AF37';
  ctx.fillText('amperes', cx, cy);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  _amperesTextTex = tex;
  return tex;
}

function zoneHeatmapTexture(splInfo) {
  const { grid, cellsX, cellsY } = splInfo;
  const canvas = document.createElement('canvas');
  canvas.width = cellsX;
  canvas.height = cellsY;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cellsX, cellsY);
  // Pick palette by metric so STIPA zones colour as STI rating bands,
  // not the SPL gradient.
  const colorFn = splInfo.metric === 'sti' ? stiColorRGB : splColorRGB;
  for (let j = 0; j < cellsY; j++) {
    for (let i = 0; i < cellsX; i++) {
      const val = grid[j][i];
      const idx = (j * cellsX + i) * 4;
      if (!isFinite(val)) { img.data[idx + 3] = 0; continue; }
      const [r, g, b] = colorFn(val);
      img.data[idx + 0] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 240;
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
  const useSTI = state.display.heatmapMode === 'stipa';
  const stipaCtx = useSTI
    ? precomputeSTIPAContext({
        sources: flat, getSpeakerDef: url => getCachedLoudspeaker(url),
        room: state.room, materials: materialsRef, zones: state.zones,
        treatments: state.treatments,
      })
    : null;
  const splResult = computeSPLGrid({
    sources: flat,
    getSpeakerDef: url => getCachedLoudspeaker(url),
    room: state.room, gridSize: roomGrid, earHeight_m: ear,
    ...currentPhysicsOpts(state.room),
    metric: useSTI ? 'sti' : 'spl',
    stipaCtx,
    ambient_per_band: useSTI ? state.physics.ambientNoise?.per_band : null,
    computeSTIPAAt: useSTI ? computeSTIPAAt : null,
  });
  if (!splResult.sourceCount || !isFinite(splResult.maxSPL_db)) return;
  // Publish the grid for the 3D legend to read (with metric tag so the
  // legend's metric filter picks it up only in matching mode).
  state.results.splGrid = splResult;
  const { grid, cellsX, cellsY } = splResult;

  const canvas = document.createElement('canvas');
  canvas.width = cellsX;
  canvas.height = cellsY;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cellsX, cellsY);

  // Pick palette by metric — STI (0..1) gets the IEC 5-tier red→teal
  // ramp; SPL gets the dB heatmap ramp. The legend reads
  // state.display.heatmapMode independently so the bar matches.
  const colorFn = splResult.metric === 'sti' ? stiColorRGB : splColorRGB;
  for (let j = 0; j < cellsY; j++) {
    for (let i = 0; i < cellsX; i++) {
      const val = grid[j][i];
      const idx = (j * cellsX + i) * 4;
      if (!isFinite(val)) {
        img.data[idx + 3] = 0;
        continue;
      }
      const [r, g, b] = colorFn(val);
      img.data[idx + 0] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      // Near-opaque per-pixel alpha. Stays < 255 so the floor grid still
      // shows through faintly — depth cue helps the user read elevation.
      img.data[idx + 3] = 240;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;

  // Heatmap plane uses the EFFECTIVE bounds of the grid — when an
  // enclosure has been merged in past the parent's bbox, computeSPLGrid
  // returns originX_m / originY_m + cellW_m × cellsX as the actual
  // covered area. Falls back to (0,0,room.width × room.depth) for the
  // common case where the parent fully contains all enclosures.
  const planeW = (splResult.cellW_m ?? 0) * cellsX || state.room.width_m;
  const planeD = (splResult.cellD_m ?? 0) * cellsY || state.room.depth_m;
  const ox = splResult.originX_m ?? 0;
  const oy = splResult.originY_m ?? 0;
  const geo = new THREE.PlaneGeometry(planeW, planeD);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0.95,
    side: THREE.DoubleSide, depthWrite: false, alphaTest: 0.01,
  });
  heatmapMesh = new THREE.Mesh(geo, mat);
  heatmapMesh.rotation.x = -Math.PI / 2;
  heatmapMesh.position.set(ox + planeW / 2, ear, oy + planeD / 2);
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
  // Only count grids whose metric matches the current heatmap mode —
  // otherwise an SPL dB grid leaks into the STI legend (and shows
  // 80–100 instead of 0–1) or vice versa. Grids from before the
  // metric tag was added default to 'spl' for back-compat.
  const wantMetric = state.display.heatmapMode === 'stipa' ? 'sti' : 'spl';
  const gridMetric = g => g.metric ?? 'spl';
  let minVal = Infinity, maxVal = -Infinity;
  let matched = 0;
  if (grids && grids.length > 0) {
    for (const g of grids) {
      if (gridMetric(g) !== wantMetric) continue;
      if (isFinite(g.minSPL_db) && g.minSPL_db < minVal) minVal = g.minSPL_db;
      if (isFinite(g.maxSPL_db) && g.maxSPL_db > maxVal) maxVal = g.maxSPL_db;
      matched++;
    }
  }
  if (matched === 0 && rg && gridMetric(rg) === wantMetric
      && isFinite(rg.minSPL_db) && isFinite(rg.maxSPL_db) && rg.sourceCount > 0) {
    minVal = rg.minSPL_db;
    maxVal = rg.maxSPL_db;
  }
  if (!isFinite(minVal) || !isFinite(maxVal)) {
    legend.classList.add('hidden');
    return;
  }
  legend.classList.remove('hidden');

  // Swap gradient + label format based on the current heatmap metric.
  const mode = state.display.heatmapMode;
  const title = legend.querySelector('.legend-title');
  const bar = legend.querySelector('.legend-bar');
  const ticksEl = legend.querySelector('.legend-ticks');
  const maxL = legend.querySelector('.legend-max');
  const minL = legend.querySelector('.legend-min');
  if (ticksEl) ticksEl.replaceChildren();

  // Helper: append one tick at `pctFromBottom` % up the bar.
  const addTick = (pctFromBottom, label) => {
    if (!ticksEl) return;
    const t = document.createElement('div');
    t.className = 'legend-tick';
    t.style.bottom = pctFromBottom.toFixed(2) + '%';
    const line = document.createElement('span');
    line.className = 'legend-tick-line';
    const lbl = document.createElement('span');
    lbl.className = 'legend-tick-label';
    lbl.textContent = label;
    t.appendChild(line);
    t.appendChild(lbl);
    ticksEl.appendChild(t);
  };

  // Tick layout shared with the 2D legend and print-report heatmap legend
  // — see js/graphics/legend-ticks.js. Cap of 7 ticks lives there.
  const tickMode = mode === 'stipa' ? 'sti' : 'spl';
  const ticks = computeTicks(minVal, maxVal, tickMode);
  if (mode === 'stipa') {
    if (title) title.textContent = 'STI';
    // Gradient matches stiColorRGB: red (bad) → orange (poor) → yellow
    // (fair) → green (good) → teal (excellent). Top of bar = 1.00.
    if (bar) bar.style.background = 'linear-gradient(to top, ' +
      '#d21414 0%, #ff8214 30%, #ffd700 45%, #3cd23c 60%, #00c896 75%, #00aadc 100%)';
    for (const t of ticks) {
      const pct = Math.max(0, Math.min(100, t.position01 * 100));
      addTick(pct, formatTickLabel(t.value, 'sti'));
    }
    if (maxL) maxL.textContent = maxVal.toFixed(2);
    if (minL) minL.textContent = minVal.toFixed(2);
  } else {
    if (title) title.textContent = 'SPL';
    if (bar) bar.style.background = 'linear-gradient(to top, ' +
      '#1428b4 0%, #008ce6 25%, #1edc50 50%, #ffd700 75%, #f01e1e 100%)';
    for (const t of ticks) {
      const pct = Math.max(0, Math.min(100, t.position01 * 100));
      addTick(pct, formatTickLabel(t.value, 'spl'));
    }
    if (maxL) maxL.textContent = maxVal.toFixed(0) + ' dB';
    if (minL) minL.textContent = minVal.toFixed(0) + ' dB';
  }
}

function onResize() {
  if (!container || !renderer || !camera) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (walkCamera) {
    walkCamera.aspect = w / h;
    walkCamera.updateProjectionMatrix();
  }
  renderer.setSize(w, h);
  if (composer) {
    composer.setSize(w, h);
    if (ssaoPass) ssaoPass.setSize(w, h);
    if (bloomPass) bloomPass.setSize(w, h);
  }
}

// Set shadow-casting flags on every mesh based on its userData tag. Called
// once per animate() frame when a rebuild flagged shadowsNeedRefresh. Keeps
// shadows on the heavy architectural geometry (concrete bowl, speakers,
// listeners) and off transparent/overlay meshes (heatmaps, grid, avatar
// body that would self-shadow in walkthrough mode).
let shadowsNeedRefresh = true;
function applyShadowFlags() {
  scene.traverse(obj => {
    if (!obj.isMesh) return;
    const tag = obj.userData.tag ?? '';
    const mat = obj.userData.acoustic_material ?? '';
    // Heatmaps never cast/receive — they're overlay layers.
    if (tag === 'heatmap_layer') { obj.castShadow = obj.receiveShadow = false; return; }
    if (tag.startsWith('heatmap_')) { obj.castShadow = obj.receiveShadow = false; return; }
    // Avatar casts AND receives — Viktor audit item #6: "avatar looks
    // pasted onto the floor without contact shadow; solvable with
    // shadowSide front-side, not by disabling shadows entirely."
    if (tag === 'walk_avatar') {
      obj.castShadow = true;
      obj.receiveShadow = true;
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => { m.shadowSide = THREE.FrontSide; });
        else obj.material.shadowSide = THREE.FrontSide;
      }
      return;
    }
    // Concrete bowl + tunnel ceilings: cast and receive.
    if (mat === 'concrete' || tag.startsWith('stadium') || tag.startsWith('tunnel_ceiling')) {
      obj.castShadow = true;  obj.receiveShadow = true;  return;
    }
    // Speaker cabinets + catwalk: cast only.
    if (mat === 'speaker_cabinet' || tag === 'catwalk_truss') {
      obj.castShadow = true;  obj.receiveShadow = false; return;
    }
    // Everything else in the room shell just receives (floor, walls, dome).
    obj.castShadow = false;
    obj.receiveShadow = true;
  });
}

function animate(ts) {
  requestAnimationFrame(animate);
  if (!renderer || !scene || !activeCamera) return;
  if (shadowsNeedRefresh) { applyShadowFlags(); shadowsNeedRefresh = false; }
  _tickSurfaceSelectionPulse(ts);
  _tickCameraFocus(ts);
  if (walkMode && tpController) {
    const now = ts || performance.now();
    const dt = Math.min(0.1, (now - tpLastTs) / 1000);
    tpLastTs = now;
    tpController.update(dt);
    // Phase 11.D + W.1 — head-rotation AND position tracking for in-
    // walk audition. Throttled to ~20 Hz (every 50 ms) per Hannes's
    // spec §4 — IR rebuild budget is 80–120 ms perceived end-to-end,
    // so a 50 ms cadence keeps the position ahead of the audio thread
    // without burning CPU. Three.js → state coord mapping:
    //   state.x = three.x, state.y = three.z, state.z = three.y + ear
    // (ear-height offset matches the rest of the listener-positioning
    // code in scene.js around line 1140).
    //
    // Yaw source: cameraYaw, NOT the avatar's anatomical yaw. Reason:
    // the user observes the scene through the chase camera, and what
    // they perceive as "left" is screen-left = camera-relative. Tying
    // audio to the camera matches that perception (also avoids the
    // L/R-swap report when the camera was orbited around the avatar).
    // Pitch already uses cameraPitch since Phase 11.D.
    if (!_lastAuditionOrientTs || now - _lastAuditionOrientTs > 50) {
      _lastAuditionOrientTs = now;
      const tp = tpController.pos;       // Three.js Vector3 (x right, y up, z back-forward)
      const earOffset = (tpController.characterHeight ?? 1.78) * 0.94;     // ~ear-canal height
      const posState = {
        x: tp.x,
        y: tp.z,
        z: tp.y + earOffset,
      };
      setAuditionListenerPose(tpController.cameraYaw, tpController.cameraPitch, posState);
    }
  } else if (controls) {
    controls.update();
  }
  // Route through the EffectComposer chain (SSAO + Bloom + SMAA + OutputPass).
  // The RenderPass needs the active camera each frame because walkthrough
  // swaps to walkCamera — we reseat it before render.
  if (composer) {
    const renderPass = composer.passes[0];
    if (renderPass && renderPass.camera !== activeCamera) renderPass.camera = activeCamera;
    if (ssaoPass && ssaoPass.camera !== activeCamera) ssaoPass.camera = activeCamera;
    composer.render();
  } else {
    renderer.render(scene, activeCamera);
  }
}
