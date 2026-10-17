// Fuel: pure, DOM-free helpers describing how fuel drains and when it is
// critical. The actual Fuel component state lives on each entity (see
// ecs/components.js); the movement system calls drainFuel() each tick and the
// HUD/flight-strips read fuelStatus() to decide when to show the low-fuel gauge.
//
// Fuel is measured in "seconds of flight" (matches def.fuelMax). Holding /
// circling burns fuel faster than cruising because the plane is spending time
// aloft without making progress toward landing.

/** Fraction of capacity at or below which the low-fuel gauge appears. */
export const LOW_FUEL_FRACTION = 0.25;
/** Fraction at or below which fuel is critical (brighter alarm). */
export const CRITICAL_FUEL_FRACTION = 0.1;
/** Multiplier applied to the drain rate while an aircraft is holding/circling. */
export const HOLDING_BURN_MULTIPLIER = 1.6;

/**
 * Drain a Fuel component by dt seconds. Holding patterns burn faster. Mutates
 * and returns the fuel object; also refreshes its `critical`/`low` flags and a
 * cached `fraction`. Returns an object including whether fuel just hit zero.
 * @param {object} fuel Fuel component {capacity, remaining, critical, ...}
 * @param {number} dt seconds
 * @param {object} [opts]
 * @param {boolean} [opts.holding] whether the aircraft is in a holding pattern
 * @returns {{remaining:number, fraction:number, low:boolean, critical:boolean, justEmptied:boolean}}
 */
export function drainFuel(fuel, dt, opts = {}) {
  const wasEmpty = fuel.remaining <= 0;
  const rate = opts.holding ? HOLDING_BURN_MULTIPLIER : 1;
  fuel.remaining = Math.max(0, fuel.remaining - dt * rate);
  const status = fuelStatus(fuel);
  fuel.fraction = status.fraction;
  fuel.low = status.low;
  fuel.critical = status.critical;
  return { ...status, justEmptied: !wasEmpty && fuel.remaining <= 0 };
}

/**
 * Report a Fuel component's current status without mutating it. Pure function.
 * @param {object} fuel {capacity, remaining}
 * @returns {{fraction:number, low:boolean, critical:boolean, empty:boolean}}
 */
export function fuelStatus(fuel) {
  const capacity = fuel.capacity > 0 ? fuel.capacity : 1;
  const fraction = Math.max(0, Math.min(1, fuel.remaining / capacity));
  return {
    fraction,
    low: fraction <= LOW_FUEL_FRACTION,
    critical: fraction <= CRITICAL_FUEL_FRACTION,
    empty: fuel.remaining <= 0,
  };
}
