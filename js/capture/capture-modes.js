// Room Capture — mode registry + runtime capability probes.
//
// The MANUAL sketcher is the guaranteed baseline every user gets — it is always
// available (no permissions, no sensors, no ML). Photo-trace, IMU assist, and
// WebXR are progressive enhancements whose impl is lazy-imported on first use
// and whose availability is probed at RUNTIME — core capture is NEVER gated
// behind them (docs/ROOM_CAPTURE_PLAN.md §3–§4, §7).
//
// isAvailable() returns boolean | Promise<boolean>. The orchestrator awaits it
// before offering a mode in the picker.

// --- capability probes (cheap, no side effects) ---------------------------

export function isManualAvailable() {
  return true;   // always — the baseline.
}

// Photo-trace: a live camera is nice, but a file/photo picker is the guaranteed
// fallback, so photo capture is "available" on essentially any browser with a
// DOM. The live-camera-vs-file decision happens INSIDE the mode (user picked
// live camera as the default — plan §9).
export function isPhotoAvailable() {
  return typeof document !== 'undefined';
}

// IMU "point at the corners": needs the DeviceOrientation API. iOS additionally
// gates the data behind DeviceOrientationEvent.requestPermission() (a user
// gesture, over HTTPS) — that prompt fires inside the mode, not here.
export function isImuAvailable() {
  return typeof window !== 'undefined' && typeof window.DeviceOrientationEvent !== 'undefined';
}

// WebXR immersive-ar (plane capture): essentially never on iOS Safari; a rare
// bonus on Android Chrome / Quest Browser. Async probe — design treats its
// ABSENCE as the normal path.
export async function isWebXrAvailable() {
  try {
    const xr = (typeof navigator !== 'undefined') ? navigator.xr : null;
    if (!xr || typeof xr.isSessionSupported !== 'function') return false;
    return await xr.isSessionSupported('immersive-ar');
  } catch {
    return false;
  }
}

// Registry. start() impls are lazy-imported so a phone that never opens
// photo/IMU/XR pays nothing for them. MVP ships with manual wired; the others
// carry their probe + a lazy loader stub that later resolves to the real mode.
//
// `implemented` gates whether the picker OFFERS a mode: manual + photo ship
// today; IMU (P3) + WebXR (far-future) carry their probe + label so the spine
// is ready, but are not offered until built (their load() rejects). `hint` is a
// one-line picker subtitle.
// @type {Array<{id:string,label:string,hint:string,implemented:boolean,isAvailable:Function,load:() => Promise<any>}>}
export const CAPTURE_MODES = [
  {
    id: 'manual',
    label: 'Draw it',
    hint: 'Tap corners on a grid — works everywhere.',
    implemented: true,
    isAvailable: isManualAvailable,
    load: () => import('./modes/manual-mode.js'),
  },
  {
    id: 'photo',
    label: 'From a photo',
    hint: 'Shoot the floor, tap the corners, set one wall length.',
    implemented: true,
    isAvailable: isPhotoAvailable,
    load: () => import('./modes/photo-trace-mode.js'),
  },
  {
    id: 'imu',
    label: 'Point at corners',
    hint: 'Pivot and aim at each corner (rough).',
    implemented: false,
    isAvailable: isImuAvailable,
    load: () => Promise.reject(new Error('IMU assist mode not yet implemented (P3)')),
  },
  {
    id: 'webxr',
    label: 'AR scan',
    hint: 'Walk the room in AR (supported devices only).',
    implemented: false,
    isAvailable: isWebXrAvailable,
    load: () => Promise.reject(new Error('WebXR mode not yet implemented (far-future)')),
  },
];

// Resolve the modes actually offerable right now: implemented AND their runtime
// probe passes (awaits async probes). The picker shows exactly these.
export async function offerableModes() {
  const out = [];
  for (const m of CAPTURE_MODES) {
    if (!m.implemented) continue;
    try { if (await m.isAvailable()) out.push(m); } catch { /* skip */ }
  }
  return out;
}

// Ids form (handy for tests / telemetry).
export async function availableModeIds() {
  return (await offerableModes()).map(m => m.id);
}
