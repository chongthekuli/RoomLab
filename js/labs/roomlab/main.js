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

import { state, SPEAKER_CATALOG, DEFAULT_PRESET_KEY, applyPresetToState, serializeProject, deserializeProject, syncToiletListeners, syncAllToiletListeners } from '../../app-state.js';
import { readAutosave, scheduleAutosave, flushAutosave } from '../../shared/autosave.js';
import { on, emit } from '../../shared/events.js';
import { loadMaterials } from '../../physics/materials.js';
import { loadLoudspeaker } from '../../physics/loudspeaker.js';
import { applyHashStateOnLoad } from '../../io/share-link.js';
import { mountRoomPanel, showToast } from '../../ui/panel-room.js';
import { mountPrintReport } from '../../ui/print-report.js';
import { mountSourcesPanel } from '../../ui/panel-sources.js';
import { mountListenersPanel } from '../../ui/panel-listeners.js';
import { mountZonesPanel } from '../../ui/panel-zones.js';
import { mountTreatmentsPanel } from '../../ui/panel-treatments.js';
import { mountFurniturePanel } from '../../ui/panel-furniture.js';
import { mountStructurePanel } from '../../ui/panel-structure.js';
import { mountAmbientPanel } from '../../ui/panel-ambient.js';
import { mountOutdoorPanel } from '../../ui/panel-outdoor.js';
import { mountResultsPanel } from '../../ui/panel-results.js';
import { mountAuthorNotePanel } from '../../ui/panel-author-note.js';
import { mountPrecisionPanel } from '../../ui/panel-precision.js';
// mountWelcomeCard import removed — terms-of-use modal is now
// mounted from js/main.js at page load.
import { mount2DViewport } from '../../graphics/room-2d.js';
import {
  mount3DViewport, toggleHeatmaps, toggleAimLines, toggleIsobars, toggleProbe,
  toggleReverbField, toggleHeatmapMode, toggleRayViz, frameCameraToRoom,
  setRackCatalogues, setWalkthroughMode,
  applyCameraPreset, detectActiveCameraPreset,
  setHeatmapFrequency,
} from '../../graphics/scene.js';
import { installCollapsibles } from '../../ui/collapsibles.js';
import { mountWalkTouchHUD } from '../../ui/walk-touch-hud.js';
import { mountRailSystem, openPanel } from '../../ui/rail-system.js';

let _mounted = false;

function setupTabs() {
  // Restrict to tabs with a data-view attribute. Other vp-tab styled
  // elements (e.g., the fullscreen toggle button which inherits
  // .vp-tab for visual consistency but has no data-view) MUST NOT be
  // treated as view-switchers — they were silently hiding every
  // viewport view because target=undefined, then the visibility
  // filter `v.id !== 'view-undefined'` matched every view.
  const tabs = document.querySelectorAll('#route-room .vp-tab[data-view]');
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

  // --- 2D grid/snap size selector (green ▾ on the 2D tab) --------------
  // Drop-down to pick the 2D grid spacing: 0.5 (default) / 0.25 / 0.1 m.
  // The 'G' key while drawing a custom room cycles the same setting. Single
  // source of truth: state.display.gridSize_m; room-2d.js re-renders on the
  // shared 'grid:changed' event.
  const gridArrow = document.getElementById('vp-grid-arrow');
  const gridMenu = document.getElementById('vp-grid-menu');
  if (gridArrow && gridMenu) {
    const closeGridMenu = () => { gridMenu.hidden = true; gridArrow.setAttribute('aria-expanded', 'false'); };
    const openGridMenu  = () => { gridMenu.hidden = false; gridArrow.setAttribute('aria-expanded', 'true'); };
    const syncGridUI = () => {
      const cur = state.display?.gridSize_m ?? 0.5;
      gridMenu.querySelectorAll('.vp-grid-opt').forEach(opt => {
        opt.setAttribute('aria-checked', parseFloat(opt.dataset.grid) === cur ? 'true' : 'false');
      });
      gridArrow.title = `Grid / snap size — ${cur} m`;
    };
    const toggleGridMenu = (ev) => {
      // Don't bubble to the 2D tab button (would switch the view).
      ev.stopPropagation();
      ev.preventDefault();
      if (gridMenu.hidden) { syncGridUI(); openGridMenu(); } else { closeGridMenu(); }
    };
    gridArrow.addEventListener('click', toggleGridMenu);
    gridArrow.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') toggleGridMenu(e);
      else if (e.key === 'Escape') closeGridMenu();
    });
    gridMenu.querySelectorAll('.vp-grid-opt').forEach(opt => {
      opt.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const m = parseFloat(opt.dataset.grid);
        if (!Number.isFinite(m)) return;
        if (!state.display) state.display = {};
        state.display.gridSize_m = m;
        emit('grid:changed');     // room-2d re-renders; syncGridUI runs via the listener below
        closeGridMenu();
      });
    });
    // Close on outside click / Escape.
    document.addEventListener('click', (e) => {
      if (gridMenu.hidden) return;
      if (e.target === gridArrow || gridMenu.contains(e.target)) return;
      closeGridMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !gridMenu.hidden) closeGridMenu(); });
    // Keep the dropdown's checkmark + tooltip in sync whenever the grid
    // changes from anywhere (this dropdown OR the 'G' key in room-2d.js).
    on('grid:changed', syncGridUI);
    syncGridUI();
  }

  // AutoCAD-style preset-view cluster. Visible only in 3D (orbit camera
  // exists). 2D has its own pan/zoom controller and Walk has the
  // first-person camera bound to the avatar — neither has a meaningful
  // notion of "Top / Front / Iso", so the cluster hides outright in
  // those modes. The viewport:tab-changed CustomEvent dispatched above
  // is our single source of truth for which view is active.
  const viewCube = document.getElementById('vp-view-cube');
  const updateViewCubeActive = () => {
    if (!viewCube || viewCube.hidden) return;
    const active = detectActiveCameraPreset();
    viewCube.querySelectorAll('.vp-view-btn').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.preset === active);
    });
  };
  if (viewCube) {
    viewCube.querySelectorAll('.vp-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.preset;
        if (!preset) return;
        applyCameraPreset(preset);
        // Optimistically mark this preset active — the tween starts now
        // and detectActiveCameraPreset() during the tween would return
        // null until the offset settles within 12° of the target.
        viewCube.querySelectorAll('.vp-view-btn').forEach(b => {
          b.classList.toggle('is-active', b === btn);
        });
        // After the 500 ms tween finishes, re-detect — clears the
        // optimistic highlight if the camera ended up "between"
        // presets due to any state change mid-tween (room resized,
        // shape swapped, etc.).
        setTimeout(updateViewCubeActive, 560);
      });
    });
    // --- Report-cam lock toggle (nested inside the Iso button) --------
    // Locked (default) → print report's 3D cover uses the fixed Iso view.
    // Unlocked → cover uses the user's CURRENT orbit angle, re-fit to the
    // cover frame. The glyph lives INSIDE the Iso .vp-view-btn, so its
    // click must stopPropagation() or it would also snap the camera to
    // iso. Reflects state.display.reportCamLocked on mount and on toggle.
    const isoLock = document.getElementById('vp-iso-lock');
    if (isoLock) {
      const syncIsoLock = () => {
        const locked = state.display.reportCamLocked !== false;
        isoLock.textContent = locked ? '🔒' : '🔓';
        isoLock.setAttribute('aria-pressed', locked ? 'true' : 'false');
        isoLock.classList.toggle('is-unlocked', !locked);
        isoLock.title = locked
          ? 'Locked: report 3D uses the fixed Iso view. Unlock to use your current camera angle.'
          : 'Unlocked: report 3D will use your CURRENT camera angle (re-fit to the cover frame). Lock to use the fixed Iso view.';
      };
      const toggleIsoLock = (ev) => {
        // Critical: don't let the click/keydown bubble to the Iso button
        // and trigger applyCameraPreset('iso').
        ev.stopPropagation();
        ev.preventDefault();
        state.display.reportCamLocked = (state.display.reportCamLocked === false);
        syncIsoLock();
      };
      isoLock.addEventListener('click', toggleIsoLock);
      isoLock.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') toggleIsoLock(e);
      });
      syncIsoLock();   // reflect initial (locked) state on mount
    }
    // Initial state: 3D is the default tab so the cube is visible. The
    // tab-changed listener below keeps it in sync on every switch.
    document.addEventListener('viewport:tab-changed', e => {
      const v = e.detail?.view;
      viewCube.hidden = (v !== '3d');
      if (!viewCube.hidden) requestAnimationFrame(updateViewCubeActive);
    });
    // First paint — after mount, the iso preset is the default camera.
    requestAnimationFrame(updateViewCubeActive);
  }

  const heatBtn = document.getElementById('toggle-heatmaps');
  const freqRow = document.querySelector('.vp-freq-row');
  const freqPills = freqRow ? Array.from(freqRow.querySelectorAll('.vp-freq-pill')) : [];
  const heatmapDependents = () => ['toggle-isobars', 'toggle-reverb', 'toggle-stipa-mode']
    .map(id => document.getElementById(id)).filter(Boolean);
  const syncHeatmapDependents = () => {
    const onState = !!state.display.showHeatmaps;
    for (const el of heatmapDependents()) el.disabled = !onState;
    // Freq pills follow the same on/off rule — choosing a band is
    // meaningless when no heatmap is being painted.
    for (const p of freqPills) p.disabled = !onState;
    if (freqRow) freqRow.setAttribute('aria-disabled', onState ? 'false' : 'true');
  };
  if (heatBtn) {
    heatBtn.addEventListener('click', () => {
      toggleHeatmaps();
      heatBtn.classList.toggle('active', state.display.showHeatmaps);
      syncHeatmapDependents();
    });
  }
  syncHeatmapDependents();

  // Heatmap octave-band selector — Maya design pass 2026-05-17. Click a
  // pill → write state.physics.freq_hz → ask scene.js to re-sample. The
  // pill row mirrors a graphic-EQ band layout because engineers think
  // "the 4k", not "position 6 of 7". Keyboard nav follows WAI-ARIA
  // radiogroup pattern (Arrow keys move active state + focus together).
  const applyFreq = (freq_hz, focusEl) => {
    if (!Number.isFinite(freq_hz)) return;
    if ((state.physics.freq_hz ?? 1000) === freq_hz) return;
    setHeatmapFrequency(freq_hz);
    for (const p of freqPills) {
      const active = Number(p.dataset.freq) === freq_hz;
      p.classList.toggle('active', active);
      p.setAttribute('aria-checked', active ? 'true' : 'false');
      p.setAttribute('tabindex', active ? '0' : '-1');
    }
    if (focusEl) focusEl.focus();
    // Refresh the right-rail per-listener SPL breakdown — panel-results
    // subscribes to listener:changed and re-renders from state.physics.freq_hz.
    try { emit('listener:changed'); } catch (_) {}
  };
  freqPills.forEach((pill, idx) => {
    pill.setAttribute('tabindex', pill.classList.contains('active') ? '0' : '-1');
    pill.addEventListener('click', () => {
      applyFreq(Number(pill.dataset.freq), pill);
    });
    pill.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight'
          && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      let next = idx;
      if (e.key === 'ArrowLeft')  next = (idx - 1 + freqPills.length) % freqPills.length;
      if (e.key === 'ArrowRight') next = (idx + 1) % freqPills.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End')  next = freqPills.length - 1;
      const target = freqPills[next];
      applyFreq(Number(target.dataset.freq), target);
    });
  });

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
  // btn-show-welcome was removed when the mandatory terms-of-use modal
  // replaced the old soft welcome tour (modal now shows every load
  // from js/main.js).
  helpOverlay?.addEventListener('click', e => { if (e.target === helpOverlay) closeHelp(); });

  // Walk-mode touch HUD (joystick + action buttons). One-time mount;
  // scene.js's setWalkthroughMode shows / hides the overlay.
  mountWalkTouchHUD();

  // P1 — viewport-first layout. Wires the icon rails on each edge
  // (Room / Sources / Listeners / … on the left, Results / Precision
  // on the right) so clicking an icon overlays that panel on top of
  // the viewport. P2 will add slide animation + frosted glass.
  mountRailSystem({ routeId: 'room' });

  // P8 — "•••" menu trigger top-right opens a slide-down panel
  // containing layer toggles + tools + keyboard shortcuts (Maya's
  // 3-cluster layout: 2D/3D/Walk persistent segmented + fullscreen +
  // this menu). State stored on <html data-more-menu>; CSS keys all
  // open/close styling off that attribute. Click-outside-to-close
  // mirrors the rail pattern.
  const moreTrigger = document.getElementById('btn-more-menu');
  const morePanel = document.getElementById('vp-more-panel');
  if (moreTrigger && morePanel) {
    morePanel.hidden = false;     // remove static `hidden`; CSS opacity handles invisibility
    const setOpen = (open) => {
      document.documentElement.toggleAttribute('data-more-menu', open);
      moreTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    moreTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(!document.documentElement.hasAttribute('data-more-menu'));
    });
    // Close on click outside.
    document.addEventListener('pointerdown', (e) => {
      if (!document.documentElement.hasAttribute('data-more-menu')) return;
      const t = e.target;
      if (!t || !(t instanceof Element)) return;
      if (t.closest('#vp-more-panel') || t.closest('#btn-more-menu')) return;
      setOpen(false);
    });
    // Close on Esc.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!document.documentElement.hasAttribute('data-more-menu')) return;
      setOpen(false);
    });
  }

  // P4.8 — click-target-to-open. When the user clicks a speaker or a
  // wall in the 3D viewport, auto-expand the relevant rail panel so
  // they land directly on that item's controls. Existing event
  // handlers in panel-sources / panel-room scroll to and pulse the
  // matching card; we just need to make sure the panel is OPEN when
  // they fire.
  on('source:highlight', () => {
    if (document.querySelector('.lab-route.active')?.dataset.route !== 'room') return;
    openPanel('left', 'sources');
  });
  on('surface:picked', () => {
    if (document.querySelector('.lab-route.active')?.dataset.route !== 'room') return;
    openPanel('left', 'room');
  });

  // Toilet round-listener follow/resync (v=780). Any structure edit (panel
  // field change, 2D drag/rotate/resize, cubicle-count change) emits
  // 'structure:changed'; re-snap that toilet's round cubicle listeners so
  // they FOLLOW the toilet and add/remove on cubicle-count change. The ADD
  // and DELETE cascades are handled at their own call sites (placeStructureAt
  // / delete paths); this central handler covers the MOVE/EDIT case. Guard
  // against the listener:changed we emit re-entering (it can't trigger
  // structure:changed, so no loop). payload.removed = a delete already
  // cascaded — skip resync for it.
  on('structure:changed', (p) => {
    if (p && p.removed) return;
    const id = p?.id;
    const s = id
      ? state.structures?.find(x => x.id === id)
      : null;
    let changed = false;
    if (s && s.type === 'toilet') {
      changed = syncToiletListeners(s);
    } else if (!id) {
      // No id in payload (e.g. drag commit emits bare 'structure:changed') —
      // resync every toilet so a dragged toilet's listeners follow.
      changed = syncAllToiletListeners();
    }
    if (changed) emit('listener:changed');
  });

  // Fullscreen toggle next to the Walk tab. Targets documentElement
  // so the WHOLE page goes fullscreen — keeps the side panels reachable,
  // hides the browser chrome on tablet, and avoids a CSS trap where
  // fullscreening a flexbox child (like #viewport) can leave the WebGL
  // canvas stuck at stale dimensions and render solid black until the
  // user resizes the window.
  //
  // Also wires `fullscreenchange` to dispatch a window-resize event so
  // any component that listens (the 3D renderer / EffectComposer / 2D
  // SVG heatmap painter) re-fits to the new viewport rect immediately.
  const fsBtn = document.getElementById('btn-fullscreen');
  if (fsBtn) {
    const updateFsIcon = () => {
      const inFs = !!document.fullscreenElement;
      fsBtn.textContent = inFs ? '⤢' : '⛶';
      fsBtn.title = inFs ? 'Exit fullscreen — Esc' : 'Toggle fullscreen — useful for tablet walk mode';
    };
    fsBtn.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else {
          await document.documentElement.requestFullscreen();
        }
      } catch (err) {
        console.warn('[fullscreen] toggle failed:', err);
      }
    });
    document.addEventListener('fullscreenchange', () => {
      updateFsIcon();
      // Toggle a class on documentElement so CSS can hide the side
      // panels (300 + 320 px of fixed grid columns) and let the
      // viewport take the full-screen rect. Without this the viewport
      // is still a ~25 % strip between panels even in fullscreen, and
      // a Three.js canvas sized to that strip looks black against the
      // huge fullscreen rect.
      document.documentElement.classList.toggle('is-fullscreen', !!document.fullscreenElement);
      // Force every renderer that listens for window resize to re-fit
      // to the new viewport rect. Done in TWO frames: one to let the
      // CSS class apply, one to fire after grid re-flows. Otherwise
      // the resize fires too early and reads stale dimensions.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.dispatchEvent(new Event('resize'));
        });
      });
    });
    updateFsIcon();
  }

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
  // toggle the heatmap behind it. Layer / tool / camera shortcuts
  // are also skipped while in walk mode (W/A/S/D are walk-controller
  // movement keys; F would frame the camera away from the avatar; H /
  // M / R toggle layers the user can't see while walking, etc.).
  // View-switching (1/2/3) and help (?) / Esc remain always-on so the
  // user can always exit walk mode or read the shortcuts list.
  document.addEventListener('keydown', (e) => {
    const activeRoute = document.querySelector('.lab-route.active')?.dataset.route;
    if (activeRoute && activeRoute !== 'room') return;
    if (isTypingTarget(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const walkActive = document.querySelector('#route-room .vp-tab.active')?.dataset.view === 'walk';
    switch (e.key) {
      case '1': clickTab('2d'); e.preventDefault(); break;
      case '2': clickTab('3d'); e.preventDefault(); break;
      case '3': clickTab('walk'); e.preventDefault(); break;
      case '?':           openHelp(); e.preventDefault(); break;
      case 'Escape':      closeTransient(); break;
    }
    if (walkActive) return;
    switch (e.key) {
      case 'h': case 'H': click('toggle-heatmaps'); e.preventDefault(); break;
      case 'i': case 'I': click('toggle-isobars'); e.preventDefault(); break;
      case 'm': case 'M': click('toggle-stipa-mode'); e.preventDefault(); break;
      case 'r': case 'R': click('toggle-reverb'); e.preventDefault(); break;
      case 'l': case 'L': click('toggle-aim-lines'); e.preventDefault(); break;
      case 'y': case 'Y': click('toggle-rays'); e.preventDefault(); break;
      case 'p': case 'P': click('toggle-probe'); e.preventDefault(); break;
      case 'f': case 'F': frameCameraToRoom(); e.preventDefault(); break;
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

  const materials = await loadMaterials('data/materials.json');
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
    'treatment:changed',
  ]) on(ev, trigger);
  trigger();
  window.addEventListener('pagehide', flushAutosave);

  setupTabs();
  mountRoomPanel({ materials });
  mountSourcesPanel({ speakerCatalog: SPEAKER_CATALOG });
  mountListenersPanel();
  mountZonesPanel({ materials });
  // Treatments panel mounts ASYNC because it awaits the SurfaceLAB
  // catalogue fetch. We don't block other panel mounts on it — the
  // panel renders a "Loading…" stub immediately and replaces it once
  // the catalogue resolves.
  mountTreatmentsPanel({ materials }).catch(err =>
    console.warn('[roomlab] treatments panel mount failed:', err));
  // FurnitureLAB sidebar — embedded mini-catalogue + placed-items
  // manager. Async because it awaits the furniture catalogue fetch
  // (same idempotent loader as the lab page; cache is shared).
  mountFurniturePanel().catch(err =>
    console.warn('[roomlab] furniture panel mount failed:', err));
  // Building-structure sidebar — parametric pillars / half-walls / partitions /
  // beams / platforms. Async because it awaits the surface catalogue (registers
  // the structure-material provider). Renders a stub immediately.
  mountStructurePanel().catch(err =>
    console.warn('[roomlab] structure panel mount failed:', err));
  mountAmbientPanel();
  mountOutdoorPanel();
  mountResultsPanel({ materials });
  mountAuthorNotePanel();
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

  // Terms-of-use modal now mounted from js/main.js at page load — no
  // need to mount it again on RoomLAB-specific lifecycle.
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
