// Tiny synchronous pub/sub EventBus for decoupling systems. Example events:
// 'aircraft:landed', 'aircraft:crashed', 'weather:windshift'. Pure module.

export function createEventBus() {
  // Map<eventName:string, Set<handler>>
  const listeners = new Map();

  /** Subscribe to an event. Returns an unsubscribe function. */
  function on(event, handler) {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler);
    return () => off(event, handler);
  }

  /** Unsubscribe a handler from an event. */
  function off(event, handler) {
    const set = listeners.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) listeners.delete(event);
    }
  }

  /** Emit an event synchronously to all current subscribers. */
  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    // Copy to tolerate handlers that subscribe/unsubscribe during dispatch.
    for (const handler of Array.from(set)) handler(payload);
  }

  /** Remove every listener (useful when tearing down a screen). */
  function clear() {
    listeners.clear();
  }

  return { on, off, emit, clear };
}
