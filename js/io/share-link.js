// Project share-link encoder/decoder for RoomLAB.
//
// Shares an entire scene as a URL fragment so a recipient who clicks
// the link sees the same room, sources, listeners, zones, EQ, etc. the
// sender had open. Encoding pipeline:
//
//   serializeProject(state)
//     → JSON.stringify
//     → TextEncoder.encode (UTF-8)         // em-dashes, ″, i18n labels
//     → Uint8Array → base64
//     → URL-safe transformation (+/= → -_, drop padding)
//
// Why TextEncoder and not raw `btoa(JSON.stringify(...))`: btoa only
// handles Latin-1. A single em-dash or ″ in a label crashes
// `InvalidCharacterError` and the user gets nothing copied. Catching
// that bug in production is too late.
//
// Why URL fragment (#) and not query string (?): the fragment never
// reaches the server (GitHub Pages doesn't see it in access logs).
// Privacy-preserving by construction.
//
// Hash policy: explicit-only. Initial page load with a hash decodes
// once and applies via deserializeProject. Subsequent hashchange
// events do NOT auto-replace state — they trigger a banner-prompt
// flow in the UI ("shared scene detected — open it?"). Silent
// data-loss is the worst class of bug; never auto-replace.

import { state, serializeProject, deserializeProject } from '../app-state.js';
import { emit } from '../ui/events.js';

// Practical URL length cap. Modern browsers support multi-megabyte
// URLs but pasting into Slack / email / iOS Safari truncates near
// 2 KB silently. 8 KB is a generous fit for hi-fi-sized projects
// (~500 chars encoded) while ruling out pavilion-class scenes
// (~70 KB encoded) before they fail in the wild.
export const SHARE_LINK_MAX_CHARS = 8000;

function bytesToBase64Url(bytes) {
  // Chunk through fromCharCode to dodge "Maximum call stack size
  // exceeded" on V8 when the array hits ~100K elements. 8K stride
  // is safe across browsers we target.
  const CHUNK = 8192;
  let str = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    str += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlToBytes(b64url) {
  // Restore standard base64 padding before atob — atob is strict.
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const str = atob(b64);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

// Encode the current state into a share link payload.
//
// Returns { hash, bytes, chars, tooLarge }:
//   - hash:     URL-safe base64 string (no leading '#')
//   - bytes:    raw UTF-8 byte length of the encoded JSON (pre-base64)
//   - chars:    final hash length — what users actually paste
//   - tooLarge: true if `chars` exceeds SHARE_LINK_MAX_CHARS
//
// Reuses serializeProject — share and Save MUST never drift. If a
// future state field needs share-only or save-only handling, do it
// in serializeProject's slimming logic, not here.
export function encodeShareLink(srcState = state) {
  const payload = serializeProject(srcState);
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  const hash = bytesToBase64Url(bytes);
  return {
    hash,
    bytes: bytes.length,
    chars: hash.length,
    tooLarge: hash.length > SHARE_LINK_MAX_CHARS,
  };
}

// Decode a hash fragment (from window.location.hash or a pasted URL).
//
// Strips a leading '#' if present, validates base64-url shape,
// decodes UTF-8 → JSON → calls deserializeProject which validates
// the schema. Throws Error with a user-presentable message on every
// failure path (bad base64, bad JSON, bad schema, future format
// version). Caller can show the error.message directly in a banner.
//
// On success, mutates `state` via deserializeProject and returns the
// same { warnings } shape, plus { applied: true }. Callers should
// emit('scene:reset') after this resolves so panels rebuild.
export function decodeShareLink(hashString) {
  if (typeof hashString !== 'string' || !hashString) {
    throw new Error('Empty share link.');
  }
  let h = hashString;
  if (h.startsWith('#')) h = h.slice(1);
  if (!h) {
    throw new Error('Empty share link.');
  }
  // Reject anything obviously not base64-url before atob throws a less
  // useful 'InvalidCharacterError'.
  if (!/^[A-Za-z0-9\-_]+$/.test(h)) {
    throw new Error('Share link is corrupted or from an older RoomLAB version.');
  }

  let bytes;
  try {
    bytes = base64UrlToBytes(h);
  } catch {
    throw new Error('Share link is corrupted (failed to decode).');
  }

  let parsed;
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Share link is corrupted (failed to read scene data).');
  }

  // deserializeProject throws its own "Unsupported file version" / "Not
  // a valid RoomLAB project file" errors; let those bubble unchanged.
  const result = deserializeProject(parsed);
  return { applied: true, ...result };
}

// Build a copy-pastable absolute URL for the current scene.
// Returns a string like "https://chongthekuli.github.io/RoomLab/#<hash>"
// or location.origin + pathname + '#' + hash for any deployment.
export function buildShareUrl(hash) {
  if (typeof window === 'undefined' || !window.location) return '#' + hash;
  const base = window.location.origin + window.location.pathname;
  return base + '#' + hash;
}

// Boot-time entry point. Called from main.js AFTER every panel mounts
// AND inside a queueMicrotask / requestAnimationFrame, so by the time
// emit('scene:reset') fires every panel's listener is registered.
//
// Without this discipline the load lands but no panel sees the event
// and the UI silently shows the previous (default) preset — Martina's
// CRITICAL flag #1.
//
// Returns { applied, error, warnings } where:
//   - applied: true iff a hash existed AND decoded successfully
//   - error:   Error instance with user-presentable message, or null
//   - warnings: array of strings from deserializeProject (defaults applied, etc.)
//
// Does NOT install a hashchange listener — that's the caller's choice
// (see decodeShareLink directly + UI banner flow). Auto-replacing on
// hashchange is a silent-data-loss footgun.
export function applyHashStateOnLoad() {
  const hash = (typeof window !== 'undefined' ? window.location.hash : '') || '';
  if (!hash || hash === '#') return { applied: false, error: null, warnings: [] };
  try {
    const result = decodeShareLink(hash);
    emit('scene:reset');
    emit('room:changed');
    return { applied: true, error: null, warnings: result.warnings ?? [] };
  } catch (err) {
    return {
      applied: false,
      error: err instanceof Error ? err : new Error(String(err)),
      warnings: [],
    };
  }
}
