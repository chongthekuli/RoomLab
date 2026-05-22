// WallLAB workbench view (Phase 1).
//
// Renders into #view-wall. Phase 1 scope:
//   • Header + BETA framing.
//   • The over-wall-acoustics BETA toggle (gates PHYSICS_P1_5 / Tier 1a).
//   • A placeholder card for the wall-isolation simulator (Phases 2-3).
//
// Toggle model (tri-state, see js/physics/feature-flags.js):
//   • PHYSICS_P1_5_ENABLED is read ONCE at load and frozen (hot loops must
//     not re-read localStorage). So the toggle writes the preference and the
//     user reloads — it shows an explicit "Reload now" affordance.
//   • An EXPLICIT On/Off choice now OVERRIDES the localhost auto-enable, so
//     flipping it actually changes the local preview (this is the fix for
//     "toggle did nothing on localhost"). The switch reflects the effective
//     post-reload state; the status line says what's stored vs the default.

import {
  PHYSICS_P1_5_ENABLED,
  isPhysicsP15AutoOrigin,
  getStoredPhysicsP15,
  getEffectivePhysicsP15,
  setStoredPhysicsP15,
} from '../../physics/feature-flags.js';

export function mountWallSim() {
  const root = document.getElementById('view-wall');
  if (!root) return;

  const autoOrigin = isPhysicsP15AutoOrigin();
  const sessionState = PHYSICS_P1_5_ENABLED;          // what the engine uses NOW
  const effectiveIntent = getEffectivePhysicsP15();   // what it'll use after reload
  const stored = getStoredPhysicsP15();               // true | false | null

  root.innerHTML = `
    <div class="wall-workbench">
      <header class="wall-head">
        <h1>WallLAB <span class="wall-beta-chip">BETA</span></h1>
        <p class="wall-sub">
          Wall sound isolation, transmission loss, and over-wall acoustics —
          with the real physics and the standard shown.
        </p>
      </header>

      <section class="wall-card wall-toggle-card" aria-labelledby="wall-toggle-h">
        <div class="wall-toggle-row">
          <div class="wall-toggle-text">
            <h2 id="wall-toggle-h">Over-wall acoustics</h2>
            <p class="wall-toggle-desc">
              Models sound bending <em>over</em> and re-radiating <em>through</em>
              walls (edge diffraction + wall re-radiation). With this off, a wall
              is treated as a hard acoustic shadow — which under-predicts the
              level near walls below high-mounted exterior sources
              (e.g. azan horns above a parapet).
              <span class="wall-validation">Beta — physics under validation.</span>
            </p>
          </div>
          <button
            id="wall-p15-toggle"
            class="wall-switch"
            type="button"
            role="switch"
            aria-checked="${effectiveIntent ? 'true' : 'false'}"
            aria-describedby="wall-toggle-status"
            aria-label="Enable over-wall acoustics (Tier 1a physics)"
          >
            <span class="wall-switch-track"><span class="wall-switch-thumb"></span></span>
            <span class="wall-switch-state">${effectiveIntent ? 'On' : 'Off'}</span>
          </button>
        </div>

        <div class="wall-toggle-status" id="wall-toggle-status">
          ${statusLine(stored, sessionState, effectiveIntent, autoOrigin)}
        </div>

        <div class="wall-reload-banner" id="wall-reload-banner" ${effectiveIntent === sessionState ? 'hidden' : ''}>
          <span>Reload the page to apply the new physics mode.</span>
          <button id="wall-reload-btn" type="button" class="wall-reload-btn">Reload now</button>
        </div>
      </section>

      <section class="wall-card wall-sim-placeholder" aria-labelledby="wall-sim-h">
        <h2 id="wall-sim-h">Wall isolation simulator</h2>
        <p class="phase-placeholder">
          Pick a wall material and vary its thickness to see the transmission
          loss (dB) per octave band, plotted against the measured data, with
          the live mass-law equation and standard cited. Coming next.
        </p>
      </section>
    </div>
  `;

  const toggle = root.querySelector('#wall-p15-toggle');
  const stateLabel = root.querySelector('.wall-switch-state');
  const statusEl = root.querySelector('#wall-toggle-status');
  const banner = root.querySelector('#wall-reload-banner');

  function applyToggle() {
    const next = toggle.getAttribute('aria-checked') !== 'true';
    const ok = setStoredPhysicsP15(next);
    if (!ok) {
      statusEl.innerHTML = `<span class="wall-status-warn">Couldn't save the setting — storage is blocked (private window?).</span>`;
      return;
    }
    toggle.setAttribute('aria-checked', next ? 'true' : 'false');
    stateLabel.textContent = next ? 'On' : 'Off';
    statusEl.innerHTML = statusLine(next, sessionState, next, autoOrigin);
    // The engine only changes on reload — show the banner whenever the chosen
    // state differs from what the engine is using THIS session. Works on
    // localhost too now that an explicit choice overrides the auto-enable.
    banner.hidden = (next === sessionState);
  }

  toggle?.addEventListener('click', applyToggle);
  // role="switch" keyboard support — Space / Enter toggle.
  toggle?.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); applyToggle(); }
  });
  root.querySelector('#wall-reload-btn')?.addEventListener('click', () => location.reload());
}

// Truthful one-liner: current session state, the saved preference (or the
// origin default), and a reload nudge when the choice hasn't taken effect yet.
function statusLine(stored, sessionState, effectiveIntent, autoOrigin) {
  const prefLabel = stored === true ? 'On'
    : stored === false ? 'Off'
    : (autoOrigin ? 'Default — on (localhost dev)' : 'Default — off (public deploy)');
  let s = `Currently <strong>${sessionState ? 'active' : 'off'}</strong> this session.
    Saved preference: <strong>${prefLabel}</strong>.`;
  if (effectiveIntent !== sessionState) {
    s += ` <span class="wall-status-auto">Reload to apply.</span>`;
  }
  return s;
}
