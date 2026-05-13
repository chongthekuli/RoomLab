// RoomLAB Suite — Terms-of-use acceptance modal.
//
// Shows on every app load. Blocks the workbench with a glass scrim +
// glass card until the user explicitly accepts. No close, no Esc,
// no "remember me." Copy by Lin (docs-writer), visual + motion spec
// by Sofia (proposal-designer). On accept a full session signature
// (UTC time, operator name, public IP, browser+OS, timezone) is
// captured in sessionStorage and read by the PDF report generator so
// every exported document carries the acceptance attestation.
//
// State machine:
//   idle → counting (4 s) → naming → enabled → accepting (1.8 s) → dismissed
// Enable gate is (countdown==done) AND (operator-name non-empty).
// No back-edges. Esc + overlay-click are no-ops in every state.
//
// Browser limitation note: there is NO API that exposes the OS
// hostname / machine name to a webpage. The operator-name field is
// the legal substitute — the user types whatever label they want to
// associate with this acceptance, and we persist it (localStorage)
// so it's pre-filled next session.

const ACCEPT_TIMESTAMP_KEY = 'roomlab.terms.acceptedAt.utc';
const ACCEPT_RECORD_KEY    = 'roomlab.terms.record';        // full JSON bundle
const OPERATOR_NAME_KEY    = 'roomlab.terms.operatorName';  // localStorage — survives sessions
const COUNTDOWN_SECONDS = 4;
const ACCEPT_ANIMATION_MS = 1800;
const IP_FETCH_TIMEOUT_MS = 4000;
const IP_FETCH_URL = 'https://api.ipify.org?format=json';

/**
 * Read the timestamp the user accepted the terms at (this session).
 * Returns null if they haven't accepted yet — callers should treat
 * that as "modal hasn't completed," not "user declined" (no decline
 * path exists). Format: "YYYY-MM-DD HH:MM:SS UTC".
 */
export function getAcceptanceTimestamp() {
  try {
    return sessionStorage.getItem(ACCEPT_TIMESTAMP_KEY);
  } catch (_) {
    return null;
  }
}

/**
 * Read the full acceptance record (this session). Shape:
 *   {
 *     acceptedAt:   "2026-05-12 14:32:08 UTC",
 *     operatorName: "John Doe / Acme Studio PC",
 *     publicIp:     "203.0.113.42" | "Not available",
 *     browser:      "Chrome 131 on Windows 11",
 *     timezone:     "Asia/Kuala_Lumpur",
 *     screen:       "1920 × 1080",
 *   }
 * Returns null if no acceptance recorded yet.
 */
export function getAcceptanceRecord() {
  try {
    const raw = sessionStorage.getItem(ACCEPT_RECORD_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Mount the terms-of-use modal. Resolves the returned Promise with
 * the full acceptance record when the user accepts (after the
 * post-acceptance animation completes, so callers can rely on the
 * workbench being fully revealed).
 */
export function mountTermsModal() {
  return new Promise((resolve) => {
    // Defensive — don't stack two modals if mountTermsModal is called
    // twice (e.g. router race).
    const existing = document.getElementById('terms-modal-scrim');
    if (existing) { existing.remove(); }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scrim = buildScrim();
    document.body.appendChild(scrim);

    // Focus trap — store the element that had focus before so we can
    // restore on dismiss (matters for screen readers).
    const previouslyFocused = document.activeElement;
    const card = scrim.querySelector('.terms-card');
    const btn = scrim.querySelector('#terms-accept-btn');
    const btnCounter = scrim.querySelector('.terms-btn-counter');
    const nameInput = scrim.querySelector('#terms-operator-name');

    // Pre-fill operator name if remembered from a previous session.
    try {
      const remembered = localStorage.getItem(OPERATOR_NAME_KEY);
      if (remembered) nameInput.value = remembered;
    } catch (_) {}

    // ---- Start fingerprint capture in parallel ---------------------
    // Kick off the IP fetch IMMEDIATELY on mount so it's almost
    // certainly resolved by the time the user clicks accept (4 s
    // countdown buys plenty of headroom). If it's slow / blocked /
    // offline, we fall back to "Not available" gracefully.
    const fingerprint = captureFingerprint();
    const ipPromise = fetchPublicIp();   // settles to string or "Not available"

    // Focus trap — keep Tab inside the modal (alternate between name
    // input and accept button).
    const focusables = [nameInput, btn];
    const trapFocus = (e) => {
      if (e.key !== 'Tab') return;
      const active = document.activeElement;
      const idx = focusables.indexOf(active);
      if (idx === -1) {
        e.preventDefault();
        nameInput.focus();
        return;
      }
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      const next = focusables[(idx + dir + focusables.length) % focusables.length];
      next.focus();
    };
    scrim.addEventListener('keydown', trapFocus);

    // Esc + scrim-click do nothing.
    scrim.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') e.preventDefault();
    });

    // ---- Enable-state gate (countdown AND name non-empty) ----------
    let countdownDone = false;
    let nameValid = nameInput.value.trim().length > 0;
    let enabled = false;

    // refreshEnable NEVER moves focus — that's the caller's job. Moving
    // focus on input-change yanks the caret out of the field on the
    // first keystroke (the input flips from empty to non-empty and the
    // gate opens). We move focus only on countdown completion (below).
    const refreshEnable = () => {
      const shouldEnable = countdownDone && nameValid;
      if (shouldEnable === enabled) return;
      enabled = shouldEnable;
      if (enabled) {
        btn.disabled = false;
        btn.classList.add('terms-btn-enabled');
        btn.querySelector('.terms-btn-label').textContent = 'I accept and continue';
        btnCounter.textContent = '';
      } else {
        btn.disabled = true;
        btn.classList.remove('terms-btn-enabled');
      }
    };

    // ---- Countdown phase (4 s) -------------------------------------
    let secondsLeft = COUNTDOWN_SECONDS;
    if (reducedMotion) {
      btn.classList.add('terms-btn-no-anim');
    }
    btnCounter.textContent = `(${secondsLeft})`;
    const tick = () => {
      secondsLeft--;
      if (secondsLeft <= 0) {
        countdownDone = true;
        btnCounter.textContent = '';
        clearInterval(intervalId);
        const wasEnabled = enabled;
        refreshEnable();
        // Only move focus to the button if the countdown just made
        // the gate flip open AND the user isn't actively typing in
        // the name field. The name-filled-from-localStorage case
        // benefits from focus jumping to the button so the user can
        // hit Enter; the "user is still typing" case must not.
        if (!wasEnabled && enabled && document.activeElement !== nameInput) {
          btn.focus();
        }
      } else {
        btnCounter.textContent = `(${secondsLeft})`;
      }
    };
    const intervalId = setInterval(tick, 1000);

    // ---- Operator-name input handling ------------------------------
    nameInput.addEventListener('input', () => {
      nameValid = nameInput.value.trim().length > 0;
      refreshEnable();
    });

    // Initial focus on the name input so the user can start typing
    // straight away (the field is the FIRST gate, not the countdown).
    requestAnimationFrame(() => { nameInput.focus(); });

    // ---- Accept phase ----------------------------------------------
    let accepting = false;
    const accept = async () => {
      if (!enabled || accepting) return;
      accepting = true;
      clearInterval(intervalId);

      const nowISO = new Date().toISOString();
      const utcText = formatUTC(new Date(nowISO));
      const operatorName = nameInput.value.trim();
      // Persist operator name for next session (privacy-safe — it's
      // whatever the user typed, never auto-derived).
      try { localStorage.setItem(OPERATOR_NAME_KEY, operatorName); } catch (_) {}

      // Resolve IP (already fetched in background — this is just await
      // on a settled promise in practice).
      const publicIp = await ipPromise;

      const record = {
        acceptedAt:   utcText,
        operatorName,
        publicIp,
        browser:      fingerprint.browser,
        timezone:     fingerprint.timezone,
        screen:       fingerprint.screen,
      };
      try {
        sessionStorage.setItem(ACCEPT_TIMESTAMP_KEY, utcText);
        sessionStorage.setItem(ACCEPT_RECORD_KEY, JSON.stringify(record));
      } catch (_) {}

      // Block further input during the animation.
      card.style.pointerEvents = 'none';
      runAcceptanceAnimation(card, scrim, record, reducedMotion, () => {
        scrim.remove();
        try { previouslyFocused?.focus?.(); } catch (_) {}
        resolve(record);
      });
    };
    btn.addEventListener('click', accept);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        if (enabled) {
          e.preventDefault();
          accept();
        }
      }
    });
    // Enter inside the name input → submit (if enabled).
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && enabled) {
        e.preventDefault();
        accept();
      }
    });
  });
}

// ---------------------------------------------------------------------
// DOM builders
// ---------------------------------------------------------------------

function buildScrim() {
  const scrim = document.createElement('div');
  scrim.id = 'terms-modal-scrim';
  scrim.className = 'terms-modal-scrim';
  scrim.setAttribute('role', 'dialog');
  scrim.setAttribute('aria-modal', 'true');
  scrim.setAttribute('aria-labelledby', 'terms-modal-heading');
  scrim.innerHTML = `
    <div class="terms-card" id="terms-card">
      <h2 id="terms-modal-heading" class="terms-heading">Terms of use — RoomLAB Suite</h2>
      <div class="terms-divider"></div>
      <ul class="terms-bullets">
        <li>
          <strong>Predictions are simulations, not measurements.</strong>
          RoomLAB computes RT60, STIPA, SPL coverage and related metrics from a browser-side physics engine.
          Any application involving safety of life or regulatory compliance — including voice-alarm and emergency PA under
          BS 5839-8, EN 54-16, IEC 60849 and MS IEC 60849 — requires independent on-site verification with calibrated instruments before sign-off.
          <div class="terms-callout">BS 5839-8 · EN 54-16 · IEC 60849 · MS IEC 60849</div>
        </li>
        <li>
          <strong>Standards are referenced, not certified.</strong>
          The engine implements published methods (ISO 3382-1, ISO 9613-1, IEC 60268-16:2020, Sabine, Eyring, Schroeder, Beranek) with documented simplifications — including diffuse-field assumptions in draft mode and flat directivity indices for unspecified sources.
          Full methodology is printed in every generated report. RoomLAB itself is not certified against any of the standards it cites.
          <div class="terms-callout">ISO 3382-1 · ISO 9613-1 · IEC 60268-16:2020 · Sabine · Beranek</div>
        </li>
        <li>
          <strong>No warranty; engineering judgement remains with you.</strong>
          The operator of this service provides RoomLAB on an as-is basis, without warranty of fitness for any purpose, and accepts no liability for design decisions made using its output.
          By continuing, you affirm that you are a competent acoustics, AV, architectural or engineering professional, or are working under the supervision of one, and will not present these predictions as commissioning-grade measurements.
        </li>
        <li>
          <strong>Acceptance is recorded and travels with your work.</strong>
          This acknowledgement is timestamped in UTC together with your operator label, public IP address, browser and platform, and is referenced on the methodology page of every PDF report generated in this session.
        </li>
      </ul>
      <p class="terms-whatsnew" aria-label="What's new in this release">
        <em>New in this build:</em> Treatments panel — drop acoustic absorbers,
        bass traps and diffusers from a 20-product catalogue onto your walls
        and ceiling. Per-band absorption is folded into RT60 / STI live
        (Sabine engine); each placed panel shows its &Delta;RT60 at 500&nbsp;Hz
        on its card, and the printed BOM lists every product. Scattering /
        diffusion behavior in the precision ray tracer is planned for v3.
      </p>
      <div class="terms-operator-row">
        <label class="terms-operator-label" for="terms-operator-name">
          Operator name / workstation label
          <span class="terms-operator-hint">required — appears on every PDF report</span>
        </label>
        <input
          id="terms-operator-name"
          class="terms-operator-input"
          type="text"
          autocomplete="name"
          spellcheck="false"
          maxlength="80"
          placeholder="e.g. John Tan / Studio-PC-01"
          aria-label="Operator name or workstation label" />
      </div>
      <button id="terms-accept-btn" class="terms-btn" type="button" disabled aria-label="I accept and continue">
        <span class="terms-btn-label">I accept and continue</span>
        <span class="terms-btn-counter" aria-hidden="true">(${COUNTDOWN_SECONDS})</span>
        <span class="terms-btn-underline" aria-hidden="true"></span>
      </button>
    </div>
  `;
  return scrim;
}

// ---------------------------------------------------------------------
// Acceptance animation — Sofia's 1.8 s sequence
// ---------------------------------------------------------------------

function runAcceptanceAnimation(card, scrim, record, reducedMotion, done) {
  if (reducedMotion) {
    card.innerHTML = renderAckHtml(record, /* staggered = */ false);
    setTimeout(() => {
      scrim.classList.add('terms-modal-exit');
      setTimeout(done, 200);
    }, 900);
    return;
  }

  // t=0: fade content out + translate -6px (280 ms)
  card.classList.add('terms-card-fade-out');
  setTimeout(() => {
    card.classList.remove('terms-card-fade-out');
    card.classList.add('terms-card-relax');
    card.innerHTML = renderAckHtml(record, /* staggered = */ true);
    setTimeout(() => {
      scrim.classList.add('terms-modal-exit');
      setTimeout(done, 300);
    }, ACCEPT_ANIMATION_MS - 280 - 20);
  }, 280);
}

function renderAckHtml(record, staggered) {
  const cls = staggered ? 'terms-ack-line terms-ack-stagger' : 'terms-ack-line';
  const rows = [
    { label: 'Operator',  value: record.operatorName },
    { label: 'Public IP', value: record.publicIp },
    { label: 'Browser',   value: record.browser },
    { label: 'Timezone',  value: record.timezone },
    { label: 'Accepted',  value: record.acceptedAt },
  ];
  // Stagger: header (0), pairs (160, 260, 360, 460, 560), footer (700)
  const dotDelay = 0;
  const startDelay = 160;
  const step = 100;
  const fingerprintRows = rows.map((r, i) => `
    <div class="terms-ack-kv ${cls}" style="--terms-ack-delay: ${startDelay + i * step}ms;">
      <span class="terms-ack-k">${escapeHtml(r.label)}</span>
      <span class="terms-ack-v">${escapeHtml(r.value)}</span>
    </div>
  `).join('');
  const tailDelay = startDelay + rows.length * step + 60;
  return `
    <div class="terms-ack-block">
      <div class="terms-ack-row">
        <span class="terms-ack-dot" aria-hidden="true" style="--terms-ack-delay: ${dotDelay}ms;"></span>
        <span class="${cls}" style="--terms-ack-delay: ${dotDelay}ms;">
          Acknowledgement recorded — this signature will appear on every PDF report generated in this session.
        </span>
      </div>
      <div class="terms-ack-kv-grid">${fingerprintRows}</div>
      <div class="${cls} terms-ack-tail" style="--terms-ack-delay: ${tailDelay}ms;">Loading workbench…</div>
    </div>
  `;
}

// ---------------------------------------------------------------------
// Fingerprint capture
// ---------------------------------------------------------------------

function captureFingerprint() {
  let timezone = 'Unknown';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown'; } catch (_) {}
  let screenStr = 'Unknown';
  try {
    if (window.screen?.width && window.screen?.height) {
      screenStr = `${window.screen.width} × ${window.screen.height}`;
    }
  } catch (_) {}
  return {
    browser:  parseBrowserAndOS(navigator.userAgent || ''),
    timezone,
    screen:   screenStr,
  };
}

// Lightweight User-Agent parser. Not bulletproof — only used for the
// human-readable signature line, never for feature detection. Examples:
//   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...
//    Chrome/131.0.0.0 Safari/537.36"  -> "Chrome 131 on Windows 10/11"
//   "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) ... Version/17.2
//    Safari/605.1.15"                  -> "Safari 17 on macOS 14"
function parseBrowserAndOS(ua) {
  // --- Browser
  let browser = 'Unknown browser';
  const edgeM = ua.match(/Edg\/(\d+)/);
  const chromeM = ua.match(/Chrome\/(\d+)/);
  const firefoxM = ua.match(/Firefox\/(\d+)/);
  const safariM = ua.match(/Version\/(\d+)[\.\d]*\s+Safari\//);
  const operaM = ua.match(/OPR\/(\d+)/);
  if (operaM)        browser = `Opera ${operaM[1]}`;
  else if (edgeM)    browser = `Edge ${edgeM[1]}`;
  else if (firefoxM) browser = `Firefox ${firefoxM[1]}`;
  else if (safariM && !/Chrome\//.test(ua)) browser = `Safari ${safariM[1]}`;
  else if (chromeM)  browser = `Chrome ${chromeM[1]}`;

  // --- OS
  let os = 'Unknown OS';
  if (/Windows NT 10\.0/.test(ua)) os = 'Windows 10/11';
  else if (/Windows NT 6\.3/.test(ua)) os = 'Windows 8.1';
  else if (/Windows NT 6\.2/.test(ua)) os = 'Windows 8';
  else if (/Windows NT 6\.1/.test(ua)) os = 'Windows 7';
  else if (/Mac OS X (\d+)[_\.](\d+)/.test(ua)) {
    const m = ua.match(/Mac OS X (\d+)[_\.](\d+)/);
    os = `macOS ${m[1]}.${m[2]}`;
  }
  else if (/Android (\d+)/.test(ua)) {
    const m = ua.match(/Android (\d+)/);
    os = `Android ${m[1]}`;
  }
  else if (/iPhone OS (\d+)_/.test(ua) || /iPad.*OS (\d+)_/.test(ua)) {
    const m = ua.match(/OS (\d+)_/);
    os = `iOS ${m[1]}`;
  }
  else if (/Linux/.test(ua)) os = 'Linux';

  return `${browser} on ${os}`;
}

async function fetchPublicIp() {
  // Single attempt with a hard timeout. If ipify is unreachable
  // (offline / corporate firewall / privacy extension), we degrade
  // gracefully to "Not available" rather than blocking the modal.
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), IP_FETCH_TIMEOUT_MS);
    const res = await fetch(IP_FETCH_URL, {
      method: 'GET',
      mode: 'cors',
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'omit',
    });
    clearTimeout(tid);
    if (!res.ok) return 'Not available';
    const data = await res.json();
    const ip = String(data?.ip || '').trim();
    return ip.length ? ip : 'Not available';
  } catch (_) {
    return 'Not available';
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function formatUTC(d) {
  // "YYYY-MM-DD HH:MM:SS UTC"
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------------
// Back-compat shim — keep the old mountWelcomeCard export so callers
// that still reference it work. Mounts the new terms modal but does
// NOT block on acceptance (returns immediately; the modal completes
// its lifecycle async).
// ---------------------------------------------------------------------
export function mountWelcomeCard() {
  mountTermsModal();
}
