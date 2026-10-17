// Reputation: pure, DOM-free logic for the controller's standing. Starts at
// MAX (100) and depletes on mistakes; a small amount recovers on each clean
// landing. When it reaches zero the player is "fired" (game over). FEAT-004/005
// extend the penalty set (weather/emergencies); keep this module DOM-free.

export const REPUTATION_MAX = 100;

/** Penalty amounts per incident type. */
export const PENALTY = Object.freeze({
  nearMiss: 8, // two planes breached separation (near-miss)
  fuelOut: 25, // a plane ran out of fuel
  excessiveHold: 6, // a plane was held/circled beyond the threshold
  stormLoss: 20, // a plane flew into a thunderstorm cell and was lost
  crash: 100, // a mid-air collision wipes the rest out
});

/** Reputation recovered for a successful landing. */
export const RECOVERY_PER_LANDING = 2;

/**
 * Create a Reputation model. `score` is clamped to [0, REPUTATION_MAX].
 */
export function createReputation(start = REPUTATION_MAX) {
  return {
    score: clamp(start),
    // Lifetime incident tally for shift-summary screens (FEAT-005).
    incidents: { nearMiss: 0, fuelOut: 0, excessiveHold: 0, stormLoss: 0, crash: 0 },

    /**
     * Apply a named penalty. Unknown types are ignored. Returns the new score.
     */
    penalize(type) {
      const amount = PENALTY[type];
      if (amount == null) return this.score;
      this.score = clamp(this.score - amount);
      if (this.incidents[type] != null) this.incidents[type] += 1;
      return this.score;
    },

    /** Recover a small amount of reputation (e.g. after a clean landing). */
    recover(amount = RECOVERY_PER_LANDING) {
      if (!(amount > 0)) return this.score;
      this.score = clamp(this.score + amount);
      return this.score;
    },

    /** Fraction of the meter that is full, 0..1 (for the UI bar). */
    fraction() {
      return this.score / REPUTATION_MAX;
    },

    /** True once reputation hits zero: the controller is fired. */
    isFired() {
      return this.score <= 0;
    },
  };
}

function clamp(v) {
  if (v < 0) return 0;
  if (v > REPUTATION_MAX) return REPUTATION_MAX;
  return v;
}
