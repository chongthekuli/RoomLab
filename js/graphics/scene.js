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
import { getCachedLoudspeaker } from '../physics/loudspeaker.js';
import { computeSPLGrid, computeZoneSPLGrid, computeMultiSourceSPL, computeRoomConstant, precomputeSPLContext, computeMultiSourceSPLFromContext } from '../physics/spl-calculator.js';
import { computeSTIPA, precomputeSTIPAContext, computeSTIPAAt } from '../physics/stipa.js';
import { roomPlanVertices, domeGeometry, isInsideRoom3D } from '../physics/room-shape.js';
import { getMaterialTexture, getMaterialPalette } from './textures.js';
import { ThirdPersonController } from './third-person-controller.js';
import { loadCharacterRig } from './character-loader.js';

let scene, camera, renderer, controls;
let composer, ssaoPass, bloomPass;
let roomGroup, sourcesGroup, listenersGroup, zonesGroup, heatmapGroup, heatmapMesh;
let aimLinesGroup, audienceGroup;
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
    });
  };

  // Register event subscriptions BEFORE the first paint — Martina audit #8.
  // If they sit after the rebuilds, a preset-click that lands between
  // boot's Promise.all(loadLoudspeaker…) and mount3DViewport completing
  // emits scene:reset into the void and the 3D view shows stale geometry.
  on('room:changed', () => queueRebuild(REBUILD_ROOM | REBUILD_ZONES | REBUILD_HEATMAP | REBUILD_AIM));
  on('source:changed', () => queueRebuild(REBUILD_SOURCES | REBUILD_ZONES | REBUILD_HEATMAP));
  on('source:model_changed', () => queueRebuild(REBUILD_SOURCES | REBUILD_ZONES | REBUILD_HEATMAP));
  on('listener:changed', () => queueRebuild(REBUILD_LISTENERS | REBUILD_HEATMAP));
  on('listener:selected', () => queueRebuild(REBUILD_LISTENERS | REBUILD_HEATMAP));
  on('scene:reset', () => queueRebuild(
    REBUILD_ROOM | REBUILD_SOURCES | REBUILD_LISTENERS | REBUILD_ZONES | REBUILD_HEATMAP
  ));
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
  animate();

  window.addEventListener('resize', onResize);
  document.addEventListener('viewport:tab-changed', e => {
    if (e.detail.view === '3d') requestAnimationFrame(onResize);
  });
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
  container.innerHTML = '';
  container.style.position = 'relative';
  container.appendChild(renderer.domElement);
  // Post-processing (SSAO/Bloom/SMAA) is temporarily disabled — the previous
  // composer chain was bleaching the entire scene through a color-pipeline
  // interaction with SSAOPass. Back to direct renderer.render() which looks
  // correct. Revisit as a separate, carefully-validated pass.
  composer = null;

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

  // --- Lighting rig — 3-light archviz setup -----------------------------
  // Hemisphere gives a subtle sky/ground tint that replaces flat ambient —
  // slightly warmer up top, cooler below, mimicking daylight bounce.
  const hemi = new THREE.HemisphereLight(0xbfd0e8, 0x2a2620, 0.4);
  hemi.position.set(0, 30, 0);
  scene.add(hemi);

  // Key: main directional light from a high front-right angle, slightly warm.
  // Only this light casts shadows (perf-friendly on arena-scale scenes).
  const key = new THREE.DirectionalLight(0xfff4e0, 1.15);
  key.position.set(25, 40, 18);
  key.castShadow = true;
  key.shadow.mapSize.width = 2048;
  key.shadow.mapSize.height = 2048;
  key.shadow.camera.near = 5;
  key.shadow.camera.far = 120;
  key.shadow.camera.left   = -45;
  key.shadow.camera.right  =  45;
  key.shadow.camera.top    =  45;
  key.shadow.camera.bottom = -45;
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  scene.add(key);

  // Fill: cooler counter-light from opposite side, no shadows, lower intensity.
  const fill = new THREE.DirectionalLight(0xa8c0d8, 0.35);
  fill.position.set(-22, 28, -10);
  scene.add(fill);

  // Rim / ambient lift so dome + bowl back don't fall into pure black.
  const ambient = new THREE.AmbientLight(0xffffff, 0.22);
  scene.add(ambient);

  // Procedural image-based lighting via RoomEnvironment — bakes subtle
  // environment reflections onto every MeshStandardMaterial without
  // shipping an HDR file. Kills the "matte clay" look on speakers and
  // concrete without costing runtime performance after the one-time bake.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

  // Subtle floor grid only — no more axes helper (looked like a WIP viewport).
  const grid = new THREE.GridHelper(60, 30, 0x262b33, 0x1a1d22);
  grid.position.y = -0.01;
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  scene.add(grid);

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
  // Click-to-inspect: tapping a loudspeaker cabinet in 3D opens the
  // Speaker workbench focused on that model.
  renderer.domElement.addEventListener('click', onSpeakerClick);
  // Hover-highlight + click-to-pivot on speakers.
  renderer.domElement.addEventListener('pointermove', onSpeakerHoverMove);
  renderer.domElement.addEventListener('pointerdown', onSpeakerPointerDown);
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
    state.selectedSpeakerUrl = url;
    emit('speaker:selected');
    document.dispatchEvent(new CustomEvent('viewport:show-speaker'));
    return;
  }
}

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
        f, R: computeRoomConstant(state.room, materialsRef, f, state.zones),
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
  // Palette — John Wick style: entirely black suit, black shirt, black tie,
  // pale skin, long dark hair, stubble/beard.
  const SKIN      = 0xd9b798;   // paler, slightly warm
  const SKIN_SHAD = 0xb89378;
  const LIP       = 0x7a4a3a;
  const SUIT      = 0x0d0e12;   // near-black with faint blue
  const SUIT_DARK = 0x050609;   // shadow detail
  const SHIRT     = 0x1a1a1e;   // black button-down visible in the V
  const TIE       = 0x08080a;
  const PANTS     = 0x0a0b10;
  const SHOE      = 0x070707;
  const HAIR      = 0x1a120a;   // very dark brown
  const BEARD     = 0x24180e;   // slightly lighter stubble tone

  const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({
    color, roughness: opts.r ?? 0.78, metalness: opts.m ?? 0.04,
  });
  const mesh = (geo, m, pos) => {
    const x = new THREE.Mesh(geo, m);
    if (pos) x.position.set(pos[0], pos[1], pos[2]);
    return x;
  };

  const root = new THREE.Group();
  // --- Rig hierarchy ---
  //   root
  //     legL, legR        (hip-pivot groups attached to the root/pelvis level)
  //     spine             (Group pivoting at the waist, y=0.92 m)
  //       body            (upper torso, head, tie, shirt, neck, pelvis band)
  //       armL, armR      (shoulder-pivot groups, attached to the spine so
  //                        arms lean + tilt WITH the torso — previous bug had
  //                        only body leaning and arms/head detaching)
  // Legs stay at root so stride rotations happen at the hip independent of
  // upper-body sway. Spine carries torso tilt + turn-lean.
  const parts = { armL: null, armR: null, legL: null, legR: null, body: new THREE.Group(), spine: new THREE.Group() };
  parts.spine.position.set(0, 0.92, 0);    // waist pivot
  // body stays at root-frame coordinates internally but lives inside spine,
  // so we offset body.position.y to cancel spine.position and keep the
  // existing absolute positions of head/torso/etc. unchanged.
  parts.body.position.y = -0.92;
  parts.spine.add(parts.body);
  root.add(parts.spine);

  // --- Head group — tailor-mannequin style: smooth egg + minimal hair cap.
  // Previous versions tried to model eyes / nose / beard / ears with
  // primitives; the result was always uncanny-valley. Abstract works better:
  // no face features, smooth pale egg, slim dark hair dome — reads as "a
  // person" without pretending to be photoreal.
  const headG = new THREE.Group();
  headG.position.set(0, 1.54, 0);

  const head = mesh(new THREE.SphereGeometry(0.115, 28, 24), mat(SKIN, { r: 0.48 }), [0, 0.13, 0]);
  head.scale.set(0.96, 1.15, 0.96);
  headG.add(head);

  // Hair — a single low dome covering the top of the skull. No nape, no
  // locks, no bangs. One surface, one material.
  const hairMat = mat(HAIR, { r: 0.82, m: 0.03 });
  const hairCap = mesh(
    new THREE.SphereGeometry(0.122, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.50),
    hairMat,
    [0, 0.16, -0.002]
  );
  hairCap.scale.set(1.0, 0.75, 1.04);
  headG.add(hairCap);

  parts.body.add(headG);

  // --- Neck -----------------------------------------------------------------
  parts.body.add(mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.08, 14), mat(SKIN), [0, 1.50, 0]));

  // --- Torso — single tapered jacket, no tie / no lapels / no buttons.
  // Read as "person in dark suit" in silhouette; detail at primitive-level
  // always looks wrong. Clean shape + material = better than fussy layers.
  const jacketGeo = new THREE.CylinderGeometry(0.17, 0.14, 0.56, 20);
  const jacket = mesh(jacketGeo, mat(SUIT, { r: 0.72, m: 0.04 }), [0, 1.17, 0]);
  jacket.scale.z = 0.7;
  parts.body.add(jacket);

  // --- Pelvis (visible band at top of pants) — narrowed to match the
  // tapered torso so there's no sudden bulge at the waist.
  const pelvis = mesh(new THREE.CylinderGeometry(0.16, 0.17, 0.12, 14), mat(PANTS), [0, 0.86, 0]);
  pelvis.scale.z = 0.7;
  parts.body.add(pelvis);
  // Belt — thin dark band around the waist.
  const belt = mesh(new THREE.CylinderGeometry(0.172, 0.172, 0.028, 14), mat(0x050505, { r: 0.3, m: 0.3 }), [0, 0.925, 0]);
  belt.scale.z = 0.7;
  parts.body.add(belt);

  // --- Arm factory — nested pivots: shoulder → elbow → (forearm + hand) ----
  // Bending the elbow is rotation on arm.elbow.rotation.x. The forearm group
  // is positioned at the elbow joint (y=-0.26 below shoulder), so rotating
  // it around X swings the forearm downward/backward naturally.
  const makeArm = (sign) => {
    const arm = new THREE.Group();
    arm.position.set(sign * 0.20, 1.42, 0);
    // Single tapered upper-arm cylinder — no shoulder-cap sphere bump.
    arm.add(mesh(new THREE.CylinderGeometry(0.055, 0.045, 0.27, 14), mat(SUIT, { r: 0.78 }), [0, -0.135, 0]));
    // Elbow group — rotation pivot only, no visible sphere.
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.27, 0);
    arm.add(elbow);
    elbow.add(mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.26, 14), mat(SUIT, { r: 0.8 }), [0, -0.13, 0]));
    // Hand — simple flattened oval. No thumb, no palm separation.
    const hand = mesh(new THREE.SphereGeometry(0.048, 14, 12), mat(SKIN, { r: 0.6 }), [0, -0.29, 0]);
    hand.scale.set(0.65, 1.25, 0.55);
    elbow.add(hand);
    arm.userData.elbow = elbow;
    return arm;
  };
  parts.armL = makeArm(-1);
  parts.armR = makeArm( 1);
  // Shoulder anchor was (sign*0.23, 1.42, 0) in root frame; subtract 0.92 so
  // the world position is unchanged when the arms live inside the spine.
  parts.armL.position.y -= 0.92;
  parts.armR.position.y -= 0.92;
  parts.spine.add(parts.armL, parts.armR);

  // --- Leg factory — nested pivots: hip → knee → (shin + shoe) --------------
  // Bending the knee is rotation on leg.knee.rotation.x. The shin group sits
  // at y=-0.42 below the hip, so rotating it around X folds the lower leg
  // (essential for crouching without the shoe sinking into the floor).
  const makeLeg = (sign) => {
    const leg = new THREE.Group();
    leg.position.set(sign * 0.11, 0.86, 0); // hip anchor
    // Thigh — attached to hip pivot.
    // Thigh tapers slightly down toward knee.
    leg.add(mesh(new THREE.CylinderGeometry(0.075, 0.062, 0.42, 14), mat(PANTS), [0, -0.21, 0]));
    const knee = new THREE.Group();
    knee.position.set(0, -0.42, 0);
    leg.add(knee);
    // Shin — no sphere at the knee joint.
    knee.add(mesh(new THREE.CylinderGeometry(0.058, 0.048, 0.40, 14), mat(PANTS), [0, -0.22, 0]));
    // Shoe — one rounded flattened ellipsoid, no toe cap / no heel bits.
    const shoe = mesh(new THREE.SphereGeometry(0.095, 16, 12), mat(SHOE, { r: 0.3, m: 0.3 }), [0, -0.44, 0.035]);
    shoe.scale.set(0.58, 0.45, 1.35);
    knee.add(shoe);
    leg.userData.knee = knee;
    return leg;
  };
  parts.legL = makeLeg(-1);
  parts.legR = makeLeg( 1);
  root.add(parts.legL, parts.legR);

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

  // --- Async GLTF character load (graceful fallback) ---
  // Kick off loading assets/models/hitman.glb in the background. If it
  // resolves, swap the procedural primitive avatar for the rigged GLTF +
  // AnimationMixer. If it 404s / fails to parse / is blocked by CORS,
  // keep the procedural avatar — scene stays playable either way.
  loadCharacterRig('assets/models/hitman.glb')
    .then(rig => {
      riggedAvatar = rig;
      // Remove procedural avatar from scene, add rigged root at the same
      // position / rotation so swap is visually seamless.
      rig.root.position.copy(avatar.position);
      rig.root.rotation.copy(avatar.rotation);
      scene.remove(avatar);
      scene.add(rig.root);
      tpController.character = rig.root;
      shadowsNeedRefresh = true;
      // eslint-disable-next-line no-console
      console.info('[walkthrough] loaded rigged character:', rig.clipNames);
    })
    .catch(err => {
      // eslint-disable-next-line no-console
      console.info('[walkthrough] hitman.glb not available, using procedural avatar:', err?.message ?? err);
    });
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
  if (walkMode) {
    placeAvatarAtDefault();
    avatar.visible = true;
    avatar.scale.set(1, 1, 1);
    if (avatarParts?.body) avatarParts.body.rotation.set(0, 0, 0);
    if (avatarParts?.spine) avatarParts.spine.rotation.set(0, 0, 0);
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
function applyAvatarAnimation(ctx) {
  const dt = ctx.dt;

  // --- Rigged GLTF fast path ---
  // When assets/models/hitman.glb loaded successfully, let the AnimationMixer
  // handle all locomotion via crossfades between idle / walk / run clips and
  // bypass the procedural joint-group pose code (which wouldn't find
  // avatarParts on a SkinnedMesh anyway).
  if (riggedAvatar) {
    riggedAvatar.setState({ moving: ctx.moving, running: ctx.running });
    riggedAvatar.update(dt);
    // Still update the SPL readout overlay at the avatar's ear height.
    if (walkSplOverlay) updateWalkSplReadout(ctx, AVATAR_EYE_HEIGHT);
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

  // --- Jump state machine ---
  // Anticipate fires the real impulse on the controller once wind-up completes;
  // airborne tracks its own airtime for blend-in; landing is detected from the
  // controller's grounded flag transitioning back to true.
  if (animState.jumpPhase === 'anticipate') {
    animState.jumpT += dt / 0.10;
    if (animState.jumpT >= 1) {
      animState.jumpT = 0;
      animState.jumpPhase = 'airborne';
      tpController.jump(JUMP_VELOCITY_MS);
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

  // --- Crouch factor ---
  const crouchHeld = ctx.keys.has('KeyC') || ctx.keys.has('ControlLeft') || ctx.keys.has('ControlRight');
  animState.crouchF += ((crouchHeld ? 1 : 0) - animState.crouchF) * (1 - Math.exp(-dt / 0.12));

  // --- Sit toggle (Z) — edge-triggered so holding Z doesn't thrash the state.
  const zHeld = ctx.keys.has('KeyZ');
  if (zHeld && !animState.sitLatch) {
    animState.sitting = !animState.sitting;
    animState.sitLatch = true;
    if (tpController) tpController.blockMovement = animState.sitting;
  }
  if (!zHeld) animState.sitLatch = false;
  animState.sitF += ((animState.sitting ? 1 : 0) - animState.sitF) * (1 - Math.exp(-dt / 0.20));

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
  const floorMat = buildSurfaceMat(surfaces.floor, w, d, { opacity: 0.95 });
  const ceilMat  = buildSurfaceMat(surfaces.ceiling, w, d, { opacity: 0.55 });
  const wallsMat = buildSurfaceMat(wallsMatId, (w + d), h, { opacity: 0.55 });

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
      const mat = buildSurfaceMat(surfId, ww, wh, { opacity: 0.55 });
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
      const cylMat = buildSurfaceMat(wallsMatId, 2 * Math.PI * r, h, { opacity: 0.55 });
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
        const segMat = buildSurfaceMat(wallsMatId, edgeLen, wallH, { opacity: 0.55 });
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
  rebuildMultiLevelStructure(room);

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

  for (const src of expandSources(state.sources)) {
    const outside = !isInsideRoom3D(src.position, state.room);
    const groupHex = src.groupId ? colorForGroup(src.groupId) : null;
    const groupInt = groupHex ? parseInt(groupHex.slice(1), 16) : null;

    const encl = buildSpeakerEnclosure(src, groupInt, outside);
    encl.position.set(src.position.x, src.position.z, src.position.y);
    // Tag the enclosure + every child mesh so a raycast hit can recover the
    // model URL (needed by the Speaker-workbench click-to-open handler).
    encl.userData.speakerModelUrl = src.modelUrl;
    encl.traverse(child => { child.userData.speakerModelUrl = src.modelUrl; });

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

  rebuildAimLines();
}

// Raycaster used for aim-line termination. Allocated once so per-element
// aim-line construction stays cheap.
const _aimRaycaster = new THREE.Raycaster();

// Builds the aim-line indicators: for every speaker element, cast a ray
// from its acoustic center along its aim vector and terminate the line at
// the first hit with room geometry (walls, floor, dome, bowl concrete).
// Lines extend up to 120 m if nothing is in the path.
function rebuildAimLines() {
  if (!aimLinesGroup) {
    aimLinesGroup = new THREE.Group();
    scene.add(aimLinesGroup);
  } else {
    disposeGroup(aimLinesGroup);
  }
  if (!roomGroup) return;
  const MAX_AIM_LEN = 200;
  const FALLBACK_LEN = 30;  // used when nothing is hit within MAX_AIM_LEN

  // Cast against room geometry AND zone geometry — with a vomitory-gapped
  // bowl (4 sectors + end caps), a ray aimed exactly through a sector
  // boundary can numerically miss every triangle if we only test roomGroup.
  // zonesGroup carries the audience-zone planes which cover those gaps
  // at seating height, so they act as a natural fallback target.
  const targets = [roomGroup];
  if (zonesGroup) targets.push(zonesGroup);

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
    const hits = _aimRaycaster.intersectObjects(targets, true);
    // First valid hit (skip heatmap layers and audience-zone heatmap
    // overlays that sit just above the floor).
    let dist = -1;
    for (const h of hits) {
      const tag = h.object.userData?.tag ?? '';
      if (tag.startsWith('heatmap_')) continue;
      dist = h.distance;
      break;
    }

    // Fallback when nothing was hit — cast the ray to the ground plane
    // (y=0). If it's horizontal or rising, clamp at FALLBACK_LEN so the
    // line still has a clear terminus instead of drifting to infinity.
    if (dist <= 0) {
      if (dirWorld.y < -1e-3) {
        const t = -originWorld.y / dirWorld.y;
        dist = Math.min(t, MAX_AIM_LEN);
      } else {
        dist = FALLBACK_LEN;
      }
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
      splInfo = computeZoneSPLGrid({
        zone, sources: flatSources,
        getSpeakerDef: url => getCachedLoudspeaker(url),
        room: state.room, gridSize: adaptiveGrid, earAbove_m: 1.2,
        ...zoneSplOpts,
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
      ? computeRoomConstant(room, materialsRef, freq, state.zones)
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
    ? precomputeSTIPAContext({ sources, getSpeakerDef: getDef, room, materials: materialsRef, zones: state.zones })
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
    room: state.room, gridSize: roomGrid, earHeight_m: ear,
    ...currentPhysicsOpts(state.room),
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

  // Swap gradient + label format based on the current heatmap metric.
  const mode = state.display.heatmapMode;
  const title = legend.querySelector('.legend-title');
  const bar = legend.querySelector('.legend-bar');
  const maxL = legend.querySelector('.legend-max');
  const minL = legend.querySelector('.legend-min');
  if (mode === 'stipa') {
    if (title) title.textContent = 'STI';
    // Gradient matches stiColorRGB: red (bad) → orange (poor) → yellow
    // (fair) → green (good) → teal (excellent). Top of bar = 1.00.
    if (bar) bar.style.background = 'linear-gradient(to top, ' +
      '#aa1e1e 0%, #e67828 30%, #e6c832 45%, #6ec85a 60%, #28aa82 75%, #148ca0 100%)';
    if (maxL) maxL.textContent = maxVal.toFixed(2);
    if (minL) minL.textContent = minVal.toFixed(2);
  } else {
    if (title) title.textContent = 'SPL';
    if (bar) bar.style.background = 'linear-gradient(to top, ' +
      '#1a1a4a 0%, #0066cc 25%, #00cc66 50%, #ffcc00 75%, #ff3300 100%)';
    if (maxL) maxL.textContent = maxVal.toFixed(0) + ' dB';
    if (minL) minL.textContent = minVal.toFixed(0) + ' dB';
  }
}

function splColorRGB(spl_db) {
  const t = Math.max(0, Math.min(1, (spl_db - 60) / 50));
  if (t < 0.25) return interpRGB([26, 26, 74], [0, 102, 204], t / 0.25);
  if (t < 0.50) return interpRGB([0, 102, 204], [0, 204, 102], (t - 0.25) / 0.25);
  if (t < 0.75) return interpRGB([0, 204, 102], [255, 204, 0], (t - 0.50) / 0.25);
  return interpRGB([255, 204, 0], [255, 51, 0], (t - 0.75) / 0.25);
}

// STIPA color palette mapped to the IEC 60268-16 5-tier rating bands.
// Red (bad) → orange (poor) → yellow (fair) → green (good) → teal (excellent).
// Legend ticks at 0.00 / 0.30 / 0.45 / 0.60 / 0.75 / 1.00 match the rating
// boundaries so the user can read off "poor vs fair" from the colour alone.
function stiColorRGB(sti) {
  const t = Math.max(0, Math.min(1, sti));
  if (t < 0.30) return interpRGB([170,  30,  30], [230, 120,  40], t / 0.30);           // bad → poor
  if (t < 0.45) return interpRGB([230, 120,  40], [230, 200,  50], (t - 0.30) / 0.15);  // poor → fair
  if (t < 0.60) return interpRGB([230, 200,  50], [110, 200,  90], (t - 0.45) / 0.15);  // fair → good
  if (t < 0.75) return interpRGB([110, 200,  90], [ 40, 170, 130], (t - 0.60) / 0.15);  // good → excellent
  return interpRGB([40, 170, 130], [20, 140, 170], (t - 0.75) / 0.25);                  // excellent → top
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
  if (walkMode && tpController) {
    const now = ts || performance.now();
    const dt = Math.min(0.1, (now - tpLastTs) / 1000);
    tpLastTs = now;
    tpController.update(dt);
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
