// RoomLAB mount module. Was the global boot script; now exports
// `mountRoomLab()` so the SPA shell can lazy-mount it the first time
// the user visits the #/room route.
//
// Subsequent visits to RoomLAB do NOT re-run mount — the router just
// shows the already-built DOM. The Three.js scene stays alive across
// route changes, which is the whole point of the SPA refactor: no more
// re-init lag every time you flip back from DeviceLAB.
//
// Cross-Lab side-effect events that persist for the page's lifetime
// (autosave subscription, pagehide flush, dev-mode hooks) are kept
// here so they fire as soon as the user touches RoomLAB once. They
// keep firing afterwards regardless of which Lab is active.

import { state, SPEAKER_CATALOG, DEFAULT_PRESET_KEY, applyPresetToState, serializeProject, deserializeProject } from '../../app-state.js';
import { readAutosave, scheduleAutosave, flushAutosave } from '../../shared/autosave.js';
import { on } from '../../shared/events.js';
import { loadMaterials } from '../../physics/materials.js';
import { loadLoudspeaker } from '../../physics/loudspeaker.js';
import { applyHashStateOnLoad } from '../../io/share-link.js';
import { mountRoomPanel, showToast } from '../../ui/panel-room.js';
import { mountPrintReport } from '../../ui/print-report.js';
import { mountSourcesPanel } from '../../ui/panel-sources.js';
import { mountListenersPanel } from '../../ui/panel-listeners.js';
import { mountZonesPanel } from '../../ui/panel-zones.js';
import { mountAmbientPanel } from '../../ui/panel-ambient.js';
import { mountResultsPanel } from '../../ui/panel-results.js';
import { mountPrecisionPanel } from '../../ui/panel-precision.js';
import { mountWelcomeCard } from '../../ui/welcome-card.js';
import { mount2DViewport } from '../../graphics/room-2d.js';
import {
  mount3DViewport, toggleHeatmaps, toggleAimLines, toggleIsobars, toggleProbe,
  toggleReverbField, toggleHeatmapMode, toggleRayViz, frameCameraToRoom,
  setRackCatalogues, setWalkthroughMode,
} from '../../graphics/scene.js';
import { installCollapsibles } from '../../ui/collapsibles.js';

let _mounted = false;

function setupTabs() {
  const tabs = document.querySelectorAll('#route-room .vp-tab');
  const views = document.querySelectorAll('#route-room .viewport-view');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.view;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      const visibleViewId = target === 'walk' ? 'view-3d' : `view-${target}`;
      views.forEach(v => { v.hidden = v.id !== visibleViewId; });
      setWalkthroughMode(target === 'walk');
      document.dispatchEvent(new CustomEvent('viewport:tab-changed', { detail: { view: target } }));
    });
  });

  const heatBtn = document.getElementById('toggle-heatmaps');
  const heatmapDependents = () => ['toggle-isobars', 'toggle-reverb', 'toggle-stipa-mode']
    .map(id => document.getElementById(id)).filter(Boolean);
  const syncHeatmapDependents = () => {
    const onState = !!state.display.showHeatmaps;
    for (const el of heatmapDependents()) el.disabled = !onState;
  };
  if (heatBtn) {
    heatBtn.addEventListener('click', () => {
      toggleHeatmaps();
      heatBtn.classList.toggle('active', state.display.showHeatmaps);
      syncHeatmapDependents();
    });
  }
  syncHeatmapDependents();

  const aimBtn = document.getElementById('toggle-aim-lines');
  if (aimBtn) {
    aimBtn.addEventListener('click', () => {
      toggleAimLines();
      aimBtn.classList.toggle('active', state.display.showAimLines);
    });
  }

  const raysBtn = document.getElementById('toggle-rays');
  if (raysBtn) {
    raysBtn.addEventListener('click', () => {
      toggleRayViz();
      raysBtn.classList.toggle('active', state.display.showRays);
    });
  }

  const stipaBtn = document.getElementById('toggle-stipa-mode');
  if (stipaBtn) {
    stipaBtn.addEventListener('click', () => {
      toggleHeatmapMode();
      stipaBtn.classList.toggle('active', state.display.heatmapMode === 'stipa');
    });
  }

  const isoBtn = document.getElementById('toggle-isobars');
  if (isoBtn) {
    isoBtn.addEventListener('click', () => {
      toggleIsobars();
      isoBtn.classList.toggle('active', state.display.showIsobars);
    });
  }

  const probeBtn = document.getElementById('toggle-probe');
  if (probeBtn) {
    probeBtn.addEventListener('click', () => {
      toggleProbe();
      probeBtn.classList.toggle('active');
    });
  }

  const reverbBtn = document.getElementById('toggle-reverb');
  if (reverbBtn) {
    reverbBtn.addEventListener('click', () => {
      toggleReverbField();
      reverbBtn.classList.toggle('active', state.physics.reverberantField);
    });
  }

  const helpOverlay = document.getElementById('help-overlay');
  const openHelp = () => { if (helpOverlay) helpOverlay.hidden = false; };
  const closeHelp = () => { if (helpOverlay) helpOverlay.hidden = true; };
  document.getElementById('btn-show-help')?.addEventListener('click', openHelp);
  document.getElementById('btn-close-help')?.addEventListener('click', closeHelp);
  document.getElementById('btn-show-welcome')?.addEventListener('click', () => {
    closeHelp();
    mountWelcomeCard({ force: true });
  });
  helpOverlay?.addEventListener('click', e => { if (e.target === helpOverlay) closeHelp(); });

  const closeTransient = () => {
    closeHelp();
    document.dispatchEvent(new CustomEvent('ui:cancel'));
  };

  const isTypingTarget = (el) => {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  };

  const click = (id) => document.getElementById(id)?.click();
  const clickTab = (v) => document.querySelector(`#route-room .vp-tab[data-view="${v}"]`)?.click();

  // Keyboard shortcuts only act while RoomLAB is the active route —
  // pressing 'H' while reading a SpeakerLAB spec sheet shouldn't
  // toggle the heatmap behind it.
  document.addEventListener('keydown', (e) => {
    const activeRoute = document.querySelector('.lab-route.active')?.dataset.route;
    if (activeRoute && activeRoute !== 'room') return;
    if (isTypingTarget(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case '1': clickTab('2d'); e.preventDefault(); break;
      case '2': clickTab('3d'); e.preventDefault(); break;
      case '3': clickTab('walk'); e.preventDefault(); break;
      case 'h': case 'H': click('toggle-heatmaps'); e.preventDefault(); break;
      case 'i': case 'I': click('toggle-isobars'); e.preventDefault(); break;
      case 'm': case 'M': click('toggle-stipa-mode'); e.preventDefault(); break;
      case 'r': case 'R': click('toggle-reverb'); e.preventDefault(); break;
      case 'a': case 'A': click('toggle-aim-lines'); e.preventDefault(); break;
      case 'y': case 'Y': click('toggle-rays'); e.preventDefault(); break;
      case 'p': case 'P': click('toggle-probe'); e.preventDefault(); break;
      case 'f': case 'F': frameCameraToRoom(); e.preventDefault(); break;
      case '?':           openHelp(); e.preventDefault(); break;
      case 'Escape':      closeTransient(); break;
    }
  });
}

async function loadJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
  return r.json();
}

export async function mountRoomLab() {
  if (_mounted) return;
  _mounted = true;

  const materials = await loadMaterials();
  await Promise.all(SPEAKER_CATALOG.map(c => loadLoudspeaker(c.url)));

  const [rackCatalogue, ampCatalog] = await Promise.all([
    loadJSON('data/racks/catalogue.json').catch(e => { console.warn('rack catalogue missing', e); return null; }),
    loadJSON('data/amplifiers/catalog.json').catch(e => { console.warn('amp catalogue missing', e); return null; }),
  ]);
  setRackCatalogues({ rackCatalogue, ampCatalog });

  // Boot order: previously-autosaved scene > URL-hash share-link >
  // default preset. With the SPA shell the autosave is mostly a
  // cold-start mechanism — once the page is loaded, RoomLAB and
  // DeviceLAB share `state` directly, so cross-Lab edits propagate
  // without going through localStorage. The autosave still earns
  // its keep on browser-close → reopen.
  const autosaved = readAutosave();
  let bootedFromAutosave = false;
  if (autosaved) {
    try {
      deserializeProject(autosaved);
      bootedFromAutosave = true;
    } catch (err) {
      console.warn('autosave: restore failed, falling back to default preset', err);
    }
  }
  if (!bootedFromAutosave
      && state.sources.length === 0 && state.listeners.length === 0 && state.zones.length === 0) {
    applyPresetToState(DEFAULT_PRESET_KEY);
  }

  // Wire autosave: every state-mutating event triggers a debounced
  // write. Captures DeviceLAB rack edits too because DeviceLAB now
  // emits `rack:changed` against the same shared `state` (no more
  // patchAutosave dance — see js/labs/devicelab/panel-rack.js).
  const trigger = () => scheduleAutosave(() => serializeProject(state));
  for (const ev of [
    'scene:reset',
    'source:changed', 'source:model_changed',
    'listener:changed',
    'zone:changed',
    'room:changed',
    'rack:changed',
    'physics:eq_changed',
  ]) on(ev, trigger);
  trigger();
  window.addEventListener('pagehide', flushAutosave);

  setupTabs();
  mountRoomPanel({ materials });
  mountSourcesPanel({ speakerCatalog: SPEAKER_CATALOG });
  mountListenersPanel();
  mountZonesPanel({ materials });
  mountAmbientPanel();
  mountResultsPanel({ materials });
  mountPrecisionPanel({ materials });

  installCollapsibles();
  mount2DViewport({ materials });

  try {
    await mount3DViewport({ materials });
  } catch (err) {
    console.error('3D viewport failed to mount:', err);
    const v3 = document.getElementById('view-3d');
    if (v3) v3.innerHTML = `<div class="viewport-2d"><div class="vp-header">3D view unavailable: ${err.message}</div></div>`;
  }

  mountWelcomeCard();
  mountPrintReport({ materials });

  // When RoomLAB becomes visible again after the user was elsewhere,
  // poke the 3D renderer so it picks up any size changes that
  // happened while it was hidden (window resize while on
  // SpeakerLAB, container width change, etc).
  document.addEventListener('route:change', (e) => {
    if (e.detail?.to !== 'room') return;
    window.dispatchEvent(new Event('resize'));
  });

  // Share-link boot apply — runs once after every panel mounts AND
  // inside a microtask so by the time emit('scene:reset') fires
  // every panel's listener is registered.
  queueMicrotask(() => {
    const hash = window.location.hash || '';
    if (!hash || hash === '#') return;
    const { applied, error, warnings } = applyHashStateOnLoad();
    if (applied) {
      const msg = warnings.length
        ? `loaded shared scene (${warnings.length} warning${warnings.length === 1 ? '' : 's'})`
        : 'loaded shared scene';
      showToast(msg, 'ok', 3500);
    } else if (error) {
      const status = document.getElementById('import-status');
      if (status) {
        status.hidden = false;
        status.className = 'import-status err';
        status.textContent = error.message;
      }
    }
  });
}
