// Hash-based router for the SPA shell. All three Labs live in the same
// page, each as a `.lab-route` container. The router shows exactly one
// route at a time based on `window.location.hash`. Mount functions
// run lazy (first time the route is visited), so SpeakerLAB doesn't
// pay the cost of building its catalogue cards until the user clicks
// its pill.
//
// Routes:
//   #/room    → RoomLAB (default if no hash or unknown)
//   #/speaker → SpeakerLAB
//   #/device  → DeviceLAB
//
// Why hash and not History API: GitHub Pages is a dumb static host. A
// hash route never reaches the server, so refresh + direct-link both
// work without a `404.html` SPA fallback hack. Browser back/forward
// both work natively.
//
// Coexistence with share-links: applyHashStateOnLoad in
// js/io/share-link.js historically treated the entire hash as a
// base64 blob. It now bails early when the hash starts with `#/`
// (route prefix).

const ROUTES = ['room', 'speaker', 'device'];
const DEFAULT_ROUTE = 'room';

/**
 * Parse the route id out of a hash. `#/speaker` → 'speaker'.
 * Returns the default route for empty / unknown / share-link hashes.
 */
export function parseRoute(hash = window.location.hash) {
  if (!hash || hash === '#') return DEFAULT_ROUTE;
  const m = /^#\/([a-z]+)/.exec(hash);
  if (!m) return DEFAULT_ROUTE;
  return ROUTES.includes(m[1]) ? m[1] : DEFAULT_ROUTE;
}

/** True iff the hash is a Lab route (not a share-link blob). */
export function isRouteHash(hash = window.location.hash) {
  return /^#\//.test(hash || '');
}

/**
 * Mount the SPA. `mounts` is a map of routeId → async () => void.
 * Each mount fn is called at most once, the first time the route is
 * shown. The router simply toggles a `.active` class on the
 * `.lab-route[data-route="<id>"]` containers — every route stays in
 * the DOM so its in-memory state is preserved.
 *
 * Emits 'route:change' (custom event on document) with detail = { from, to }
 * after the swap so Labs can react (RoomLAB resizes the Three.js renderer
 * when its route becomes visible again, etc).
 */
export function startRouter({ mounts, onRouteChange } = {}) {
  if (!mounts || typeof mounts !== 'object') {
    throw new Error('startRouter: mounts is required');
  }
  const mounted = new Set();
  let current = null;

  async function show(routeId) {
    const target = ROUTES.includes(routeId) ? routeId : DEFAULT_ROUTE;
    if (target === current) return;

    const from = current;
    current = target;

    // Lazy-mount the route on first visit.
    if (!mounted.has(target) && typeof mounts[target] === 'function') {
      mounted.add(target);   // mark eagerly so concurrent route-change events don't double-mount
      try {
        await mounts[target]();
      } catch (err) {
        console.error(`router: mount(${target}) failed`, err);
      }
    }

    // Toggle visibility. Done AFTER the mount completes so the user
    // doesn't see an empty container flash.
    document.querySelectorAll('.lab-route').forEach(el => {
      el.classList.toggle('active', el.dataset.route === target);
    });

    // Header nav active state.
    document.querySelectorAll('#app-header .lab-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.lab === target);
      if (el.dataset.lab === target) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });

    document.dispatchEvent(new CustomEvent('route:change', { detail: { from, to: target } }));
    if (typeof onRouteChange === 'function') onRouteChange(target, from);
  }

  function onHashChange() {
    show(parseRoute());
  }

  window.addEventListener('hashchange', onHashChange);
  // Initial route. Use replaceState so the URL gets the canonical
  // form (`#/room`) without polluting history when the user landed
  // on `/` or a stale `?model=` search.
  if (!isRouteHash()) {
    const route = DEFAULT_ROUTE;
    history.replaceState(null, '', `#/${route}`);
  }
  show(parseRoute());

  return { show, getRoute: () => current };
}
