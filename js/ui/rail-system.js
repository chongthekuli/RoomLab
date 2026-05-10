// Rail system — viewport-first layout controller.
//
// Owns the icon rails on each edge and the panels they toggle. Each
// rail icon has data-panel + data-side; clicking it opens that panel
// on that side as an overlay (NOT a grid column — the viewport stays
// full-bleed underneath).
//
// State model:
//   <html data-rail-left="<panel-id>">  → that panel is open on the left
//   <html data-rail-right="<panel-id>"> → that panel is open on the right
//   absence of attribute → side is collapsed
//
// CSS keys all panel-show/hide off these attributes (see main.css's
// `.rail-panel` block) so the JS here only mutates one attribute per
// click — no per-panel display toggles, no inline styles. This keeps
// the surface for P2 (animation) trivial: replace `display: none/block`
// CSS with transform-based slide and the JS doesn't change at all.
//
// Persistence: sessionStorage under the keys `roomlab.rail.left` and
// `roomlab.rail.right`. SessionStorage (per Hannes §11 q1) so demos
// always start fresh; survives intra-session route changes but not
// browser restarts.
//
// Public API:
//   mountRailSystem({routeId})
//     Wires icon clicks for the rails inside #route-<routeId>. Restores
//     last-session state. Idempotent across remounts.
//   openPanel(side, panelId)
//   closePanel(side)
//   getOpenPanel(side)            → panel-id or null
//   onRailChange(handler)         → emits {side, panelId} on every change
//
// The system is suite-wide. Each lab calls mountRailSystem with its
// own routeId; rails inside that route become live. SpeakerLAB and
// DeviceLAB will hook in during P4.

import { on } from './events.js';

const STORAGE_PREFIX = 'roomlab.rail.';
const _listeners = new Set();
const _mounted = new Set();         // routeIds we've already wired

// Animation window — must outlive the longest CSS transition (320 ms
// open + a few frames of safety). During this window the panel carries
// `will-change: transform, opacity` so the compositor pre-allocates a
// GPU layer; after the window the hint is removed so the panel doesn't
// permanently pin a layer (Viktor §4 perf constraint #1).
const ANIM_WINDOW_MS = 380;
// Close-then-open gap when the user switches panels on the SAME rail.
// Concurrent cross-fade between two glass surfaces stacks two backdrop
// filters and tanks FPS; sequential close→open keeps the cost flat
// (Hannes §3, "switching panels on the same rail").
const SAME_RAIL_GAP_MS = 60;

function persistKey(routeId, side) {
  return `${STORAGE_PREFIX}${routeId}.${side}`;
}

function readPersisted(routeId, side) {
  try { return sessionStorage.getItem(persistKey(routeId, side)) || null; }
  catch (_) { return null; }
}

function writePersisted(routeId, side, panelId) {
  try {
    if (panelId == null) sessionStorage.removeItem(persistKey(routeId, side));
    else sessionStorage.setItem(persistKey(routeId, side), panelId);
  } catch (_) { /* private mode etc. */ }
}

function setHtmlAttr(side, panelId) {
  const root = document.documentElement;
  const attr = `data-rail-${side}`;
  if (panelId == null) root.removeAttribute(attr);
  else root.setAttribute(attr, panelId);
}

// Scope will-change to the animation window. CSS-only would require
// permanent will-change which Viktor refused; this keeps the GPU
// layer hint short-lived. Multiple toggles within the window reset
// the timer (Map-based) so the hint stays alive through a rapid
// open→close sequence.
//
// IDs `#panel-left` / `#panel-right` are reused across labs (RoomLAB,
// SpeakerLAB, DeviceLAB). getElementById returns the FIRST match in
// the document, which would always be RoomLAB's panel. Scope the
// query to the currently-active route so the correct lab's panel
// gets the `is-animating` class.
const _animTimers = new Map();         // side → timeoutId
function flagAnimating(side) {
  const active = document.querySelector('.lab-route.active');
  const panel = active?.querySelector(`#panel-${side}`);
  if (!panel) return;
  panel.classList.add('is-animating');
  const key = `${active.dataset.route}.${side}`;
  if (_animTimers.has(key)) clearTimeout(_animTimers.get(key));
  _animTimers.set(key, setTimeout(() => {
    panel.classList.remove('is-animating');
    _animTimers.delete(key);
  }, ANIM_WINDOW_MS));
}

function getHtmlAttr(side) {
  return document.documentElement.getAttribute(`data-rail-${side}`);
}

function refreshActiveStates(routeRoot) {
  const left  = getHtmlAttr('left');
  const right = getHtmlAttr('right');
  for (const btn of routeRoot.querySelectorAll('.rail-icon')) {
    const side = btn.dataset.side;
    const panel = btn.dataset.panel;
    const active = (side === 'left'  && panel === left)
                || (side === 'right' && panel === right);
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    // P6.b — full a11y triple. aria-expanded mirrors active state for
    // assistive tech that distinguishes "toggle button pressed" from
    // "disclosure button expanded." aria-controls links the icon to
    // the panel content it reveals. The id on aria-controls points
    // to <section id="panel-<panelId>"> which is the actual panel
    // body — screen readers announce "expands [panel name]."
    btn.setAttribute('aria-expanded', active ? 'true' : 'false');
    btn.setAttribute('aria-controls', `panel-${panel}`);
  }
  // aria-hidden on the panel surfaces themselves so screen readers
  // don't announce them when collapsed.
  routeRoot.querySelector('#panel-left')?.setAttribute('aria-hidden', left  ? 'false' : 'true');
  routeRoot.querySelector('#panel-right')?.setAttribute('aria-hidden', right ? 'false' : 'true');
}

// Move focus to the first focusable element inside a newly-opened
// panel. Improves keyboard a11y — opening a panel via keyboard means
// the user can immediately interact with its first control without
// hunting for it. Falls back to focusing the panel body itself
// (tabindex=-1) so screen readers still announce the new context.
function focusPanelFirstChild(side, panelId) {
  const active = document.querySelector('.lab-route.active');
  const section = active?.querySelector(`#panel-${panelId}`);
  if (!section) return;
  const focusable = section.querySelector(
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  if (focusable) {
    // Defer one frame so the slide animation has begun and the panel
    // has interactive layout — focusing too early can scroll the
    // viewport unexpectedly.
    requestAnimationFrame(() => focusable.focus({ preventScroll: true }));
  }
}

// Return focus to the rail icon that controls a panel after it
// closes via keyboard (Esc) or programmatic close. Pointer-driven
// closes (clicking outside) don't restore focus — the user has
// indicated where their attention is by clicking elsewhere.
function focusRailIcon(side, panelId) {
  const active = document.querySelector('.lab-route.active');
  const btn = active?.querySelector(`.rail-icon[data-side="${side}"][data-panel="${panelId}"]`);
  if (btn) requestAnimationFrame(() => btn.focus({ preventScroll: true }));
}

function emit(side, panelId) {
  for (const fn of _listeners) {
    try { fn({ side, panelId }); } catch (e) { console.warn('[rail] listener threw:', e); }
  }
}

export function openPanel(side, panelId) {
  if (side !== 'left' && side !== 'right') return;
  flagAnimating(side);
  setHtmlAttr(side, panelId);
  const routeId = document.querySelector('.lab-route.active')?.dataset.route ?? 'room';
  writePersisted(routeId, side, panelId);
  for (const id of _mounted) {
    const root = document.getElementById(`route-${id}`);
    if (root) refreshActiveStates(root);
  }
  emit(side, panelId);
}

export function closePanel(side) {
  if (side !== 'left' && side !== 'right') return;
  flagAnimating(side);
  setHtmlAttr(side, null);
  const routeId = document.querySelector('.lab-route.active')?.dataset.route ?? 'room';
  writePersisted(routeId, side, null);
  for (const id of _mounted) {
    const root = document.getElementById(`route-${id}`);
    if (root) refreshActiveStates(root);
  }
  emit(side, null);
}

export function togglePanel(side, panelId) {
  const current = getHtmlAttr(side);
  if (current === panelId) {
    closePanel(side);
  } else if (current) {
    // Switching panels on the same rail: close first, then open after
    // a small gap. Concurrent cross-fade with two glass surfaces is
    // perf-expensive (Hannes §3); sequential keeps the blur cost flat.
    closePanel(side);
    setTimeout(() => openPanel(side, panelId), SAME_RAIL_GAP_MS);
  } else {
    openPanel(side, panelId);
  }
}

export function getOpenPanel(side) {
  return getHtmlAttr(side);
}

export function onRailChange(handler) {
  _listeners.add(handler);
  return () => _listeners.delete(handler);
}

// Re-apply the html data-rail-* attributes for the currently-active
// route. Called on route changes so the panel state belongs to the
// route the user is now looking at, not the route they came from.
function syncToActiveRoute() {
  const active = document.querySelector('.lab-route.active');
  const routeId = active?.dataset.route;
  if (!routeId || !_mounted.has(routeId)) {
    // Active route has no rail system mounted yet — clear any stale
    // attributes from a previous route so its open-panel selectors
    // don't accidentally match a section in the new route's DOM.
    setHtmlAttr('left', null);
    setHtmlAttr('right', null);
    return;
  }
  const left = readPersisted(routeId, 'left');
  const right = readPersisted(routeId, 'right');
  setHtmlAttr('left', left);
  setHtmlAttr('right', right);
  refreshActiveStates(active);
}

let _routeWatcherInstalled = false;
function installRouteWatcher() {
  if (_routeWatcherInstalled) return;
  _routeWatcherInstalled = true;
  window.addEventListener('hashchange', () => {
    // Two RAFs so the router has time to flip the .active class on
    // the route div before we sync.
    requestAnimationFrame(() => requestAnimationFrame(syncToActiveRoute));
  });
}

export function mountRailSystem({ routeId }) {
  installRouteWatcher();
  if (_mounted.has(routeId)) return;
  const root = document.getElementById(`route-${routeId}`);
  if (!root) {
    console.warn('[rail] route element missing:', routeId);
    return;
  }
  _mounted.add(routeId);

  // Wire icon clicks via event delegation so dynamically-added rails
  // (future labs) don't need re-binding.
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('.rail-icon');
    if (!btn || !root.contains(btn)) return;
    const side = btn.dataset.side;
    const panel = btn.dataset.panel;
    if (!side || !panel) return;
    const wasOpen = getHtmlAttr(side) === panel;
    togglePanel(side, panel);
    // P6.b — keyboard activation: if Enter/Space was used (synthetic
    // click with no real coordinates), move focus into the newly-
    // opened panel so the user can immediately tab through controls.
    // Mouse / touch users keep their click target focus.
    const isKeyboardClick = e.detail === 0 && e.clientX === 0 && e.clientY === 0;
    if (isKeyboardClick && !wasOpen) {
      // togglePanel may have used SAME_RAIL_GAP_MS for cross-panel
      // switching; defer focus accordingly.
      const delay = (getOpenPanel(side) === panel) ? 0 : 70;
      setTimeout(() => focusPanelFirstChild(side, panel), delay);
    }
    e.preventDefault();
  });

  // Esc closes whichever side is currently active. Closes both sides
  // if both are open (one Esc per close). Returns focus to the rail
  // icon that controlled the panel (a11y: keyboard users land back
  // where they entered).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.lab-route.active')?.dataset.route !== routeId) return;
    // Skip when typing in an input.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (getHtmlAttr('right')) {
      const id = getHtmlAttr('right');
      closePanel('right');
      focusRailIcon('right', id);
      e.preventDefault();
      return;
    }
    if (getHtmlAttr('left')) {
      const id = getHtmlAttr('left');
      closePanel('left');
      focusRailIcon('left', id);
      e.preventDefault();
      return;
    }
  });

  // Click-outside-to-close — when the user clicks anywhere that ISN'T
  // a rail icon, a rail panel, or an interactive control (button /
  // input / select / textarea / label), any open panel slides closed.
  //
  // Includes clicks on:
  //   - 3D / 2D viewport canvas (so panning / orbiting drops the panel)
  //   - blank space in the top tabs bar
  //   - blank space in the app header
  //   - any "behind the building" / empty-area click
  //
  // Excludes:
  //   - rail icons (they have their own toggle)
  //   - rail panel content (so you can interact with the panel)
  //   - any button / input / select / textarea / label (so 2D/3D/Walk,
  //     Save / Load / Print, Heatmap toggle, etc. don't slam the
  //     panel shut when the user is using them)
  //
  // pointerdown not click — closes BEFORE the viewport drag starts so
  // the close animation overlaps with the drag.
  document.addEventListener('pointerdown', (e) => {
    if (document.querySelector('.lab-route.active')?.dataset.route !== routeId) return;
    if (!getHtmlAttr('left') && !getHtmlAttr('right')) return;
    const t = e.target;
    if (!t || !(t instanceof Element)) return;
    if (t.closest('.rail-icon') || t.closest('.rail-panel')) return;
    if (t.closest('button, input, select, textarea, label')) return;
    if (getHtmlAttr('left'))  closePanel('left');
    if (getHtmlAttr('right')) closePanel('right');
  });

  // Restore last-session state for this route.
  const savedLeft  = readPersisted(routeId, 'left');
  const savedRight = readPersisted(routeId, 'right');
  if (savedLeft)  setHtmlAttr('left',  savedLeft);
  if (savedRight) setHtmlAttr('right', savedRight);
  refreshActiveStates(root);

  // Lift the no-flash guard once the browser has had a frame to apply
  // the restored state. After this, transitions are live for user
  // interactions; the initial position render did not animate.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.documentElement.classList.remove('no-transitions-yet');
    });
  });
}
