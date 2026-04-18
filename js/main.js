import { state } from './app-state.js';

console.log('RoomLAB booting', state);
document.getElementById('viewport').textContent =
  'Viewport — Three.js deferred. Phase 2 focus: RT60.';
