// js/shared/terms-record.js
// ---------------------------------------------------------------------------
// Single source of truth for the Terms-of-Use ACCEPTANCE RECORD — the
// timestamped legal attestation captured when the user accepts the terms on
// the sign-in page (js/auth/auth-gate.js). The PDF report
// (js/ui/print-report.js, via js/ui/welcome-card.js) reads this record for the
// methodology / acceptance page of every exported document.
//
// The storage keys + record shape are STABLE and mirror the originals in
// welcome-card.js so the report's existing reader keeps working unchanged.
// Do not rename them without updating both readers.
// ---------------------------------------------------------------------------

export const ACCEPT_TIMESTAMP_KEY = 'roomlab.terms.acceptedAt.utc';
export const ACCEPT_RECORD_KEY    = 'roomlab.terms.record';

const IP_FETCH_TIMEOUT_MS = 4000;
const IP_FETCH_URL = 'https://api.ipify.org?format=json';

// Read the UTC timestamp the user accepted at (this session), or null.
export function getAcceptanceTimestamp() {
  try { return sessionStorage.getItem(ACCEPT_TIMESTAMP_KEY); } catch (_) { return null; }
}

// Read the full acceptance record (this session), or null. Shape:
//   { acceptedAt, operatorName, publicIp, browser, timezone, screen }
export function getAcceptanceRecord() {
  try {
    const raw = sessionStorage.getItem(ACCEPT_RECORD_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

export function hasAcceptedThisSession() {
  return !!getAcceptanceTimestamp();
}

/**
 * Build and persist the acceptance record for this session. `operatorName` is
 * the author label printed on every report — now the signed-in account
 * identity. Resolves to the stored record (publicIp degrades to
 * "Not available" if the lookup is blocked/offline).
 */
export async function recordAcceptance({ operatorName } = {}) {
  const fp = captureFingerprint();
  const publicIp = await fetchPublicIp();
  const acceptedAt = formatUTC(new Date());
  const record = {
    acceptedAt,
    operatorName: operatorName || 'Not on record',
    publicIp,
    browser: fp.browser,
    timezone: fp.timezone,
    screen: fp.screen,
  };
  try {
    sessionStorage.setItem(ACCEPT_TIMESTAMP_KEY, acceptedAt);
    sessionStorage.setItem(ACCEPT_RECORD_KEY, JSON.stringify(record));
  } catch (_) {}
  return record;
}

// ---------------------------------------------------------------------------
// Fingerprint capture (moved from welcome-card.js — same behavior)
// ---------------------------------------------------------------------------

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
    browser: parseBrowserAndOS(navigator.userAgent || ''),
    timezone,
    screen: screenStr,
  };
}

// Lightweight User-Agent parser — only for the human-readable signature line,
// never for feature detection.
function parseBrowserAndOS(ua) {
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
  // Single attempt with a hard timeout. Degrades to "Not available" if ipify
  // is unreachable (offline / firewall / privacy extension).
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), IP_FETCH_TIMEOUT_MS);
    const res = await fetch(IP_FETCH_URL, {
      method: 'GET', mode: 'cors', signal: ctrl.signal,
      cache: 'no-store', credentials: 'omit',
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

function formatUTC(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}
