// Walk-mode "Press E to open/close" interaction — pure helpers.
//
// The proximity scan + scene-graph traversal + state toggle live in scene.js
// (they need Three.js groups + the controller). These two pure functions — the
// nearest-pick and the prompt copy — are split out so they're Node-testable.

const DEFAULT_REACH_M = 1.8;

/**
 * Nearest interactable within reach, by horizontal (x,z world) distance.
 * @param {number} ax avatar world x
 * @param {number} az avatar world z
 * @param {Array<{wx:number, wz:number}>} candidates each with world x/z (+ payload)
 * @param {number} [reachM]
 * @returns {object|null} the nearest candidate (with a `dist` field), or null
 */
export function pickNearestInteractable(ax, az, candidates, reachM = DEFAULT_REACH_M) {
  let best = null, bestD = reachM;
  for (const c of candidates || []) {
    if (!c || !Number.isFinite(c.wx) || !Number.isFinite(c.wz)) continue;
    const d = Math.hypot(ax - c.wx, az - c.wz);
    if (d <= bestD) { bestD = d; best = c; }
  }
  return best ? { ...best, dist: bestD } : null;
}

// Friendly noun for the prompt.
function nounFor(kind, opKind) {
  if (kind === 'rack') return 'rack door';
  if (opKind === 'window') return 'window';
  return 'door';
}

/**
 * Centered-HUD prompt text for a focused interactable.
 * @param {'opening'|'rack'} kind
 * @param {'door'|'window'|null} opKind  opening sub-kind (null for racks)
 * @param {boolean} isOpen  current state
 * @returns {string} e.g. "Press E to open the window"
 */
export function interactionPromptText(kind, opKind, isOpen) {
  const verb = isOpen ? 'close' : 'open';
  return `Press E to ${verb} the ${nounFor(kind, opKind)}`;
}

export { DEFAULT_REACH_M };
