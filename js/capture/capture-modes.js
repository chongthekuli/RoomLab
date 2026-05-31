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
// @type {Array<{id:string,label:string,isAvailable:Function,load:() => Promise<any>}>}
export const CAPTURE_MODES = [
  {
    id: 'manual',
    label: 'Draw it',
    isAvailable: isManualAvailable,
    load: () => import('./modes/manual-mode.js'),
  },
  {
    id: 'photo',
    label: 'From a photo',
    isAvailable: isPhotoAvailable,
    // P2 — not yet implemented. Honest rejection (no 404) until the impl lands.
    load: () => Promise.reject(new Error('photo-trace mode not yet implemented (P2)')),
  },
  {
    id: 'imu',
    label: 'Point at corners',
    isAvailable: isImuAvailable,
    load: () => Promise.reject(new Error('IMU assist mode not yet implemented (P3)')),
  },
  {
    id: 'webxr',
    label: 'AR scan',
    isAvailable: isWebXrAvailable,
    load: () => Promise.reject(new Error('WebXR mode not yet implemented (far-future)')),
  },
];

// Resolve the modes actually offerable right now (awaits async probes). The
// picker shows these; with only `manual` implemented today the others won't have
// a loadable impl yet, so the orchestrator filters to modes whose load resolves
// — but the registry + probes are the spine P2/P3 plug into without refactors.
export async function availableModeIds() {
  const out = [];
  for (const m of CAPTURE_MODES) {
    try { if (await m.isAvailable()) out.push(m.id); } catch { /* skip */ }
  }
  return out;
}
