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

// Canonical localStorage key for the Tier 1a toggle (WallLAB).
//
// TRI-STATE — the value distinguishes three intents, which a plain boolean
// read cannot (note Boolean('0') === true, so explicit-off would otherwise be
// indistinguishable from on):
//   '1'  → force ON  (even off-localhost / public deploy)
//   '0'  → force OFF (even ON localhost — lets the WallLAB toggle preview the
//                     simplified through-wall deploy model locally)
//   null → no explicit preference → fall back to the localhost dev default
export const PHYSICS_P1_5_STORAGE_KEY = 'PHYSICS_P1_5';

// Raw stored value: '1' | '0' | null. Throws-safe (Node / sandboxed iframe /
// storage-blocked private windows all yield null).
function _storedRawP15() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(PHYSICS_P1_5_STORAGE_KEY);
  } catch {
    return null;
  }
}

// Auto-enable on localhost so the dev workflow doesn't require typing
// the localStorage command into DevTools every time the developer
// spins up a fresh local-server session or a private window. Public
// deploy on any non-localhost origin still requires the explicit
// localStorage opt-in. Node test runners have no `window` → returns
// false → tests stay on the flag-off parity path. Re-added cleanly
// post the f.1/f.2/f.3 revert per workflow rules.
function _isLocalhost() {
  try {
    if (typeof window === 'undefined' || !window.location) return false;
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '';
  } catch {
    return false;
  }
}

// Resolve the effective flag from the tri-state preference + origin. An
// EXPLICIT stored '1'/'0' always wins; only an absent preference falls back to
// the localhost auto-enable. This is what lets the WallLAB toggle override the
// localhost default and preview the simplified model locally.
function _resolveP15(raw) {
  if (raw === '1') return true;
  if (raw === '0') return false;
  return _isLocalhost();
}

export const PHYSICS_P1_5_ENABLED = _resolveP15(_storedRawP15());

if (typeof console !== 'undefined') {
  const raw = _storedRawP15();
  if (PHYSICS_P1_5_ENABLED) {
    const reason = raw === '1' ? 'localStorage.PHYSICS_P1_5=1 (WallLAB toggle)'
      : 'localhost auto-enable';
    console.log(`[physics] Tier 1a ENABLED via ${reason} — multi-path diffraction + Kuttruff wall re-radiation + ground reflection active`);
  } else if (raw === '0') {
    console.log('[physics] Tier 1a DISABLED via localStorage.PHYSICS_P1_5=0 (WallLAB toggle) — simplified through-wall model active');
  }
}

// ---------------------------------------------------------------------------
// WallLAB beta-toggle support (2026-05-22).
//
// The exported `PHYSICS_P1_5_ENABLED` above is read ONCE at module load and
// frozen — hot loops must not re-read localStorage every tick. So the WallLAB
// toggle CANNOT change the live render mid-session; it writes the preference
// and the user reloads. These helpers let the toggle UI read the explicit
// preference, the effective post-reload state, and the origin default.

// True when the current origin would auto-enable Tier 1a IN THE ABSENCE of an
// explicit stored preference (localhost dev). The toggle uses this to label
// the default — NOT to lock the switch (an explicit choice now overrides it).
export function isPhysicsP15AutoOrigin() {
  return _isLocalhost();
}

// The effective state the engine will use AFTER the next reload, given the
// current stored preference + origin. This is what the toggle switch reflects.
export function getEffectivePhysicsP15() {
  return _resolveP15(_storedRawP15());
}

// The EXPLICIT stored preference: true ('1'), false ('0'), or null (no
// preference → defaulting to the origin behaviour). Lets the UI distinguish
// "you chose this" from "defaulting to localhost dev".
export function getStoredPhysicsP15() {
  const raw = _storedRawP15();
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

// Write the explicit preference. true → '1', false → '0'. BOTH are explicit
// and override the localhost auto-enable on the next load. Returns true on
// success (false when storage is blocked — private window).
export function setStoredPhysicsP15(on) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(PHYSICS_P1_5_STORAGE_KEY, on ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

// Clear the explicit preference → revert to the origin default (localhost
// auto-on / public-deploy off) on the next load.
export function clearStoredPhysicsP15() {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.removeItem(PHYSICS_P1_5_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// INTERIM SAFETY OVERRIDE (added 2026-05-24) — disables Tier 1a contributions
// (Maekawa diffraction, Kuttruff wall re-radiation, image-source overhead,
// porch enclosure) FOR OUTDOOR MODE ONLY. Indoor heatmap is unaffected.
//
// Why this exists: the 2026-05-24 tri-agent audit (Dr. Chen + Martina + Sam)
// identified an architectural bug in the diffraction module — `for crossing of
// wallsCrossed` energy-sums Maekawa bypass over every edge of every crossed
// wall, treating series barriers as parallel bypass channels. ISO 9613-2
// §7.4.2 says single-dominant-screen, not parallel sum. The fix is a 5-6 day
// rewrite (Phase A substrate + Phase B physics rework — see
// docs/HEATMAP_AUDIT_SYNTHESIS_2026-05-24.md). During that window, demos and
// screenshots of the surau preset (or any outdoor preset) over-predict
// shadowed-cell SPL by 3-8 dB. This override gives the user a clean
// direct+reverb fallback for the outdoor heatmap until the rewrite lands.
//
// READ AT RUNTIME, not at module load — so the toggle takes effect on the
// next heatmap render without a page reload. localStorage is read once per
// SPL context build (once per heatmap frame), not per cell.
//
// Default: NOT disabled (current Tier 1a behaviour preserved). The user
// opts INTO the safety override when they need it.
//
// GRADUATION: this entire block + the consumer call in
// `js/physics/spl-calculator.js` is DELETED in the Phase B commit that
// makes the diffraction physics correct.

export const PHYSICS_TIER1A_OUTDOOR_OVERRIDE_KEY = 'PHYSICS_TIER1A_OUTDOOR_OVERRIDE';

// True iff the user has explicitly opted into the interim safety override.
// '1' = disable outdoor Tier 1a. Anything else (including '0', null, missing,
// or storage-blocked) = leave Tier 1a active. Runtime read; no module-load
// caching so the toggle is live.
export function isTier1aOutdoorOverrideDisabled() {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(PHYSICS_TIER1A_OUTDOOR_OVERRIDE_KEY) === '1';
  } catch {
    return false;
  }
}

// Write the override preference. true → '1', false → remove the key entirely
// so a future toggle of the global PHYSICS_P1_5 doesn't get hidden behind a
// stale override. Returns true on success (false when storage is blocked).
export function setTier1aOutdoorOverrideDisabled(on) {
  try {
    if (typeof localStorage === 'undefined') return false;
    if (on) localStorage.setItem(PHYSICS_TIER1A_OUTDOOR_OVERRIDE_KEY, '1');
    else    localStorage.removeItem(PHYSICS_TIER1A_OUTDOOR_OVERRIDE_KEY);
    return true;
  } catch {
    return false;
  }
}
