// Re-export the shared event bus so RoomLAB's existing
// `import { on, emit } from './events.js'` sites keep working without
// churn. The canonical implementation lives in js/shared/events.js so
// SpeakerLAB and DeviceLAB can use the same module without depending
// on RoomLAB's UI tree.
export { on, off, emit } from '../shared/events.js';
