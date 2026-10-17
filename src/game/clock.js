// Shift clock: pure, DOM-free mapping of elapsed real seconds to an in-game
// time of day across a shift window (default 06:00 -> 14:00, an 8-hour shift
// compressed into SHIFT_REAL_SECONDS of real play). format() returns "HH:MM"
// and isShiftOver() reports when the window is exhausted.

const MINUTES_PER_DAY = 24 * 60;

/**
 * Create a shift clock.
 * @param {object} [opts]
 * @param {number} [opts.startMinutes] in-game start time, minutes past midnight
 *   (default 06:00 = 360).
 * @param {number} [opts.endMinutes] in-game end time, minutes past midnight
 *   (default 14:00 = 840).
 * @param {number} [opts.realSeconds] real seconds the shift lasts (default 480,
 *   i.e. 8 minutes of play for the 8-hour shift).
 */
export function createClock(opts = {}) {
  const startMinutes = opts.startMinutes ?? 6 * 60;
  const endMinutes = opts.endMinutes ?? 14 * 60;
  const realSeconds = opts.realSeconds ?? 480;
  const span = Math.max(1, endMinutes - startMinutes);

  return {
    startMinutes,
    endMinutes,
    realSeconds,
    elapsed: 0, // real seconds elapsed in the shift

    /** Advance the clock by real seconds. */
    tick(dt) {
      if (dt > 0) this.elapsed += dt;
      return this.elapsed;
    },

    /** Set the elapsed time directly (useful for syncing to sim time). */
    setElapsed(seconds) {
      this.elapsed = Math.max(0, seconds);
    },

    /** Current in-game time in minutes past midnight (does not pass the end). */
    currentMinutes() {
      const frac = Math.min(1, this.elapsed / this.realSeconds);
      return startMinutes + span * frac;
    },

    /** Fraction of the shift completed, 0..1. */
    progress() {
      return Math.min(1, this.elapsed / this.realSeconds);
    },

    /** The in-game time as "HH:MM" (24-hour). */
    format() {
      return formatMinutes(this.currentMinutes());
    },

    /** True once the full shift window has elapsed. */
    isShiftOver() {
      return this.elapsed >= this.realSeconds;
    },
  };
}

/** Format minutes-past-midnight as "HH:MM". Pure helper. */
export function formatMinutes(minutes) {
  let m = Math.floor(minutes);
  m = ((m % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return pad2(hh) + ":" + pad2(mm);
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}
