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
  // Snapshot subscribers so a handler that subscribes / unsubscribes mid-
  // dispatch doesn't skip or double-fire remaining handlers. Martina audit
  // #6 — Set.forEach iteration order is undefined under concurrent
  // mutation, and re-entrant emits across panels had become likely.
  for (const fn of [...set]) {
    try { fn(payload); }
    catch (err) {
      // Never let one panel's error mask later handlers' work. Log loudly
      // so the console flags the broken handler without silencing the app.
      console.error(`[events] handler for "${event}" threw:`, err);
    }
  }
}
