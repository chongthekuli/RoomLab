// Shared event bus — module-level singleton scoped per-page (each Lab
// loads its own copy via its own JS module graph). RoomLAB re-exports
// from js/ui/events.js so the existing import sites under js/ui/* keep
// working unchanged.
//
// Event names are convention-only; subscribe with `on('scene:reset', fn)`
// and emit with `emit('scene:reset', payload?)`.

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
}

export function off(event, fn) {
  listeners.get(event)?.delete(fn);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  // Snapshot subscribers so a handler that subscribes / unsubscribes
  // mid-dispatch doesn't skip or double-fire remaining handlers.
  for (const fn of [...set]) {
    try { fn(payload); }
    catch (err) {
      console.error(`[events] handler for "${event}" threw:`, err);
    }
  }
}
