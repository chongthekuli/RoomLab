// Room Capture — orchestration + the SINGLE commit path.
//
// Every capture mode (manual sketch, photo-trace, IMU, WebXR) resolves a
// CaptureResult and is then DONE — it never writes state.room. This module is
// the one place captured geometry lands, so the downstream acoustic sim is
// agnostic to how the room was produced (docs/ROOM_CAPTURE_PLAN.md §4–§8).
//
// Split: buildRoomFields() is PURE (Node-testable) and owns the geometry →
// room-state mapping; commitCapturedRoom() is the thin writer that applies it to
// the live state and fires the reset events. The pure geometry helpers live in
// ./geometry/*.

import { state } from '../app-state.js';
import { emit } from '../ui/events.js';
import { normalizeOrigin } from './geometry/scale-anchor.js';
import { isSelfIntersecting } from './geometry/polygon-ops.js';

/**
 * @typedef {Object} CaptureResult
 * @property {{x:number,y:number}[]} vertices  rough polygon, metres, floor plane,
 *   state +y = north. NOT yet origin-shifted (commit owns vertex[0]=(0,0)).
 * @property {boolean} scaleResolved  true = real metres; false = arbitrary unit
 *   still awaiting a scale anchor (must be resolved BEFORE commit).
 * @property {{edgeIndex:number, lengthHint_m:number}|null} [scaleHint]
 * @property {number|null} [heightHint_m]
 * @property {'manual'|'photo'|'imu'|'webxr'} provenance
 * @property {number} [confidence]  0..1 advisory only (drives banner copy).
 */

/**
 * @typedef {Object} CaptureMode
 * @property {string} id
 * @property {string} label
 * @property {() => (boolean|Promise<boolean>)} isAvailable  runtime capability probe
 * @property {(host: HTMLElement, ctx: object) => CaptureSession} start
 */

/**
 * @typedef {Object} CaptureSession
 * @property {Promise<CaptureResult|null>} done  resolves with the polygon, null on cancel
 * @property {() => void} cancel  tear down camera streams / RAF / listeners
 */

// Validate a CaptureResult is committable: ≥3 finite vertices, scale resolved,
// and not a self-intersecting bowtie (which would break RT60 surface area + the
// precision tracer). Returns { ok, reason }.
export function validateCaptureResult(result) {
  if (!result || !Array.isArray(result.vertices)) return { ok: false, reason: 'no vertices' };
  const verts = result.vertices.filter(v => v && Number.isFinite(v.x) && Number.isFinite(v.y));
  if (verts.length < 3) return { ok: false, reason: 'need ≥3 valid vertices' };
  if (result.scaleResolved !== true) return { ok: false, reason: 'scale not resolved' };
  if (isSelfIntersecting(verts)) return { ok: false, reason: 'polygon self-intersects' };
  return { ok: true, reason: null };
}

/**
 * PURE: map a (scale-resolved) CaptureResult to the room geometry fields. Runs
 * the vertex[0]=(0,0) origin shift + bbox derive (normalizeOrigin). Does NOT
 * touch surfaces.edges (that depends on the current room's wall material — set
 * in commitCapturedRoom). Returns the patch to apply to state.room.
 *
 * @returns {{ shape:'custom', custom_vertices:{x,y}[], width_m:number, depth_m:number, height_m?:number }}
 */
export function buildRoomFields(result) {
  const verts = result.vertices.filter(v => v && Number.isFinite(v.x) && Number.isFinite(v.y));
  const { vertices, width_m, depth_m } = normalizeOrigin(verts);
  const patch = { shape: 'custom', custom_vertices: vertices, width_m, depth_m };
  if (Number.isFinite(result.heightHint_m) && result.heightHint_m > 0) {
    patch.height_m = result.heightHint_m;
  }
  return patch;
}

// The current room's per-edge wall material slot, mirroring the existing
// room-2d finishDraw behaviour (`state.room.surfaces.walls || 'gypsum-board'`).
// A slot may be a string id OR a {materialId, thickness_m, openings} object —
// normalizeWallSlot downstream accepts both.
function currentWallSlot(room) {
  return room?.surfaces?.walls ?? 'gypsum-board';
}

/**
 * The ONE writer of captured geometry. Applies buildRoomFields to state.room,
 * rebuilds surfaces.edges (one slot per wall) from the current wall material,
 * and emits BOTH scene:reset (whole geometry arrays were replaced — CLAUDE.md
 * state-events invariant) and room:changed. Returns true on commit, false if
 * the result is invalid (caller keeps the user in the editor).
 *
 * @param {CaptureResult} result
 * @param {{ silent?: boolean }} [opts]  silent=true skips event emission (the
 *   caller, e.g. room-2d finishDraw, will emit) — keeps a single emit per action.
 */
export function commitCapturedRoom(result, opts = {}) {
  const v = validateCaptureResult(result);
  if (!v.ok) {
    console.warn(`[capture] commit refused: ${v.reason}`);
    return false;
  }
  const patch = buildRoomFields(result);
  const room = state.room;
  room.shape = patch.shape;
  room.custom_vertices = patch.custom_vertices;
  room.width_m = patch.width_m;
  room.depth_m = patch.depth_m;
  if (patch.height_m != null) room.height_m = patch.height_m;
  const slot = currentWallSlot(room);
  room.surfaces = room.surfaces || {};
  room.surfaces.edges = patch.custom_vertices.map(() => slot);
  if (!opts.silent) {
    // Whole-array geometry swap → scene:reset (every panel rebuilds), plus
    // room:changed for the room-specific listeners.
    emit('scene:reset');
    emit('room:changed');
  }
  return true;
}
