// js/physics/feature-flags.js
//
// Module-level read of experimental-physics localStorage gates. Read
// ONCE at module load, exported as `const` booleans so callers don't
// re-read localStorage on every hot-loop tick.
//
// To toggle a flag in development:
//   1. Open DevTools console.
//   2. localStorage.setItem('PHYSICS_P1_5', '1');     // any truthy value
//   3. Reload the page.
//
// To disable:
//   localStorage.removeItem('PHYSICS_P1_5');
//   (then reload)
//
// When a flagged feature graduates to default-on, the flag + every
// `if (PHYSICS_P1_5_ENABLED)` branch gets DELETED in the graduation
// commit. We do not carry half-life code.
//
// Current flags:
//   PHYSICS_P1_5  — Tier 1a: Maekawa edge diffraction + Kuttruff wall
//                   re-radiation. When OFF, the engine falls back to
//                   Tier 1 behaviour (direct + through-wall TL only).
//                   When ON, both contributions energy-sum alongside
//                   the direct path. Default OFF until UAT signs off.

function _readFlag(name) {
  try {
    return Boolean(typeof localStorage !== 'undefined' && localStorage.getItem(name));
  } catch {
    // Node test runners, sandboxed iframes, and old browsers may throw
    // on localStorage access. Treat as flag off.
    return false;
  }
}

export const PHYSICS_P1_5_ENABLED = _readFlag('PHYSICS_P1_5');

if (PHYSICS_P1_5_ENABLED && typeof console !== 'undefined') {
  console.log('[physics] Tier 1a ENABLED via localStorage.PHYSICS_P1_5 — Maekawa diffraction + Kuttruff wall re-radiation active');
}
