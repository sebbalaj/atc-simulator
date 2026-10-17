// Progression: pure, DOM-free shift management and end-of-shift summary
// aggregation. A "shift" is one play of a map on the shift clock (see
// clock.js). The manager tracks per-shift counters (planes landed, revenue
// earned, incidents), decides when the shift is over, builds a summary object
// for the end-of-shift screen, and gates which maps are unlocked as shifts are
// survived.
//
// Everything here is plain data + functions so it is unit-testable under Node.

import { MAP_ORDER } from "./maps.js";

/** A per-shift accumulator. Reset at the start of each shift. */
export function createShiftStats() {
  return {
    landed: 0,
    crashed: 0,
    revenue: 0,
    incidents: { nearMiss: 0, fuelOut: 0, excessiveHold: 0, stormLoss: 0, crash: 0 },
    emergenciesHandled: 0,
  };
}

/**
 * Create the shift/progression manager.
 * @param {object} [opts]
 * @param {number} [opts.startShift] 1-based shift number to start on.
 * @param {number} [opts.unlockedMaps] how many maps are unlocked initially.
 * @param {number} [opts.target] revenue target that marks a "successful" shift.
 */
export function createProgression(opts = {}) {
  const state = {
    shift: opts.startShift ?? 1,
    mapIndex: opts.mapIndex ?? 0,
    // Number of maps the player may select. Starts at 1 (Regional only).
    unlockedMaps: clampUnlocked(opts.unlockedMaps ?? 1),
    target: opts.target ?? 3000,
    active: false,
    stats: createShiftStats(),
  };

  return {
    state,

    /** Begin a new shift: reset the per-shift counters. */
    startShift() {
      state.active = true;
      state.stats = createShiftStats();
      return state.stats;
    },

    /** Record a landing with its revenue. */
    recordLanding(revenue = 0) {
      state.stats.landed += 1;
      if (revenue > 0) state.stats.revenue += revenue;
    },

    /** Record an incident of a named type (matches reputation penalties). */
    recordIncident(type) {
      if (state.stats.incidents[type] != null) state.stats.incidents[type] += 1;
      if (type === "crash") state.stats.crashed += 1;
    },

    /** Record a successfully handled emergency (for bonus accounting). */
    recordEmergency() {
      state.stats.emergenciesHandled += 1;
    },

    /**
     * Whether the current shift has ended. A clock that reports isShiftOver()
     * ends the shift; so does a game-over (fired/crash) passed in explicitly.
     */
    isShiftComplete(clock, gameOver = false) {
      if (gameOver) return true;
      return !!(clock && clock.isShiftOver && clock.isShiftOver());
    },

    /**
     * Build the end-of-shift summary. `reputationScore` is the final reputation
     * (0..100). `survived` is false when the shift ended by firing/crash. A
     * bonus is awarded when revenue meets the target and the shift was survived.
     */
    endShift({ reputationScore = 100, survived = true } = {}) {
      state.active = false;
      const stats = state.stats;
      const metTarget = stats.revenue >= state.target;
      const bonus = computeBonus({ stats, metTarget, survived });
      const summary = {
        shift: state.shift,
        mapIndex: state.mapIndex,
        landed: stats.landed,
        crashed: stats.crashed,
        revenue: stats.revenue,
        target: state.target,
        metTarget,
        survived,
        reputation: reputationScore,
        incidents: { ...stats.incidents },
        emergenciesHandled: stats.emergenciesHandled,
        bonus,
        total: stats.revenue + bonus,
      };
      return summary;
    },

    /**
     * Advance to the next shift. Surviving unlocks the next map (capped at the
     * registry size) and bumps the shift counter. Returns the new shift number.
     */
    advance({ survived = true } = {}) {
      state.shift += 1;
      if (survived) {
        state.unlockedMaps = clampUnlocked(state.unlockedMaps + 1);
      }
      return state.shift;
    },

    /** Set the active map index (which map the next shift is played on). */
    selectMap(index) {
      if (index >= 0 && index < MAP_ORDER.length && index < state.unlockedMaps) {
        state.mapIndex = index;
        return true;
      }
      return false;
    },

    /** Map id currently selected for play. */
    currentMapId() {
      return MAP_ORDER[state.mapIndex] ?? MAP_ORDER[0];
    },

    /** Whether a map index is unlocked for selection. */
    isMapUnlocked(index) {
      return index >= 0 && index < state.unlockedMaps;
    },
  };
}

/** Clamp an unlocked-map count into [1, MAP_ORDER.length]. */
function clampUnlocked(n) {
  if (!(n >= 1)) return 1;
  if (n > MAP_ORDER.length) return MAP_ORDER.length;
  return Math.floor(n);
}

/**
 * Compute a shift bonus. Surviving + meeting the revenue target pays a flat
 * target bonus; each handled emergency adds a small amount; each crash/incident
 * is already reflected in reputation so no extra penalty is subtracted here.
 * Pure function.
 */
export function computeBonus({ stats, metTarget, survived }) {
  if (!survived) return 0;
  let bonus = 0;
  if (metTarget) bonus += 1000;
  bonus += (stats.emergenciesHandled ?? 0) * 250;
  return bonus;
}

/**
 * Aggregate a list of per-shift summaries into a running career total. Pure
 * helper used by the summary screen / tests.
 */
export function aggregateSummaries(summaries) {
  const totals = { landed: 0, revenue: 0, bonus: 0, crashed: 0, emergenciesHandled: 0 };
  for (const s of summaries) {
    totals.landed += s.landed ?? 0;
    totals.revenue += s.revenue ?? 0;
    totals.bonus += s.bonus ?? 0;
    totals.crashed += s.crashed ?? 0;
    totals.emergenciesHandled += s.emergenciesHandled ?? 0;
  }
  totals.total = totals.revenue + totals.bonus;
  return totals;
}
