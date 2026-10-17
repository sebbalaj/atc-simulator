// Seedable pseudo-random number generator (mulberry32). Deterministic for a
// fixed seed so spawning and events are reproducible and testable. Pure module.

/**
 * Create a deterministic RNG seeded by an integer.
 * @param {number} seed - 32-bit unsigned seed.
 */
export function createRng(seed = 1) {
  // Coerce to a 32-bit unsigned integer state.
  let state = seed >>> 0;

  /** Next float in [0, 1). */
  function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  function range(min, max) {
    return min + next() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  function rangeInt(min, max) {
    return Math.floor(min + next() * (max - min + 1));
  }

  /** Pick a random element from a non-empty array. */
  function pick(array) {
    if (!array || array.length === 0) return undefined;
    return array[Math.floor(next() * array.length)];
  }

  /** Return true with probability p in [0, 1]. */
  function chance(p) {
    return next() < p;
  }

  return { next, range, rangeInt, pick, chance };
}
