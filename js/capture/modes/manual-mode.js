// Manual sketcher — the guaranteed baseline capture mode (every user gets it).
//
// Unlike photo/IMU/WebXR (which produce a rough CaptureResult that the
// orchestrator scale-resolves + commits), the manual sketcher IS the in-place
// editor: it drives the existing room-2d draw flow, which already does
// tap-to-drop / snap / auto-close / drag-to-correct and commits on finish via
// commitCapturedRoom (the single writer). So this adapter just starts that flow
// and exposes it as a CaptureMode so the future mode-picker can list every mode
// uniformly. See docs/ROOM_CAPTURE_PLAN.md §4–§5.

import { startDrawCustomShape } from '../../graphics/room-2d.js';

/** @type {import('../capture-flow.js').CaptureMode} */
export const manualMode = {
  id: 'manual',
  label: 'Draw it',
  isAvailable: () => true,
  start() {
    startDrawCustomShape();
    // The room-2d flow commits itself on finish (onFinish → commitCapturedRoom);
    // there is nothing for the orchestrator to commit afterward.
    return { done: Promise.resolve(null), cancel() {} };
  },
};

export default manualMode;
