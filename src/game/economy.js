// Economy: pure, DOM-free logic for landing revenue and a simple Bank model.
// Kept free of any browser dependency so it can be unit-tested under Node and
// reused by later features (the upgrade shop in FEAT-005 reads this Bank).
//
// Revenue model (balanced so heavier / higher-passenger jets pay more, and a
// shorter time in the airspace earns an efficiency bonus):
//   revenue = round( (base[kind] + passengers * perPassenger[kind]) * efficiency )
// where efficiency scales from EFFICIENCY_MAX down toward EFFICIENCY_MIN as the
// time the aircraft spent in the airspace grows past EFFICIENCY_FULL_TIME.

import { AircraftKind } from "./aircraft.js";

/** Flat landing fee per class (before passenger and efficiency scaling). */
export const BASE_FEE = Object.freeze({
  [AircraftKind.LIGHT]: 120,
  [AircraftKind.HELICOPTER]: 220,
  [AircraftKind.SUPERSONIC]: 600,
  [AircraftKind.COMMERCIAL]: 800,
});

/** Revenue earned per passenger carried, per class. */
export const PER_PASSENGER = Object.freeze({
  [AircraftKind.LIGHT]: 14,
  [AircraftKind.HELICOPTER]: 18,
  [AircraftKind.SUPERSONIC]: 40,
  [AircraftKind.COMMERCIAL]: 12,
});

// Efficiency curve. A plane landed at or under EFFICIENCY_FULL_TIME seconds
// earns the full EFFICIENCY_MAX multiplier; after that the multiplier decays
// linearly toward EFFICIENCY_MIN by EFFICIENCY_SLOW_TIME.
export const EFFICIENCY_MAX = 1.5;
export const EFFICIENCY_MIN = 0.8;
export const EFFICIENCY_FULL_TIME = 20; // seconds
export const EFFICIENCY_SLOW_TIME = 120; // seconds

/**
 * The efficiency multiplier for a given time in the airspace (seconds). Shorter
 * time => higher multiplier (bonus). Clamped to [EFFICIENCY_MIN, EFFICIENCY_MAX].
 * Pure function.
 */
export function efficiencyMultiplier(timeInAirspace) {
  const t = Math.max(0, timeInAirspace ?? 0);
  if (t <= EFFICIENCY_FULL_TIME) return EFFICIENCY_MAX;
  const span = EFFICIENCY_SLOW_TIME - EFFICIENCY_FULL_TIME;
  const over = Math.min(span, t - EFFICIENCY_FULL_TIME);
  const frac = over / span; // 0..1
  return EFFICIENCY_MAX - (EFFICIENCY_MAX - EFFICIENCY_MIN) * frac;
}

/**
 * Compute the revenue awarded for a landing. Pure function.
 * @param {object} info
 * @param {string} info.kind aircraft kind (AircraftKind.*)
 * @param {number} info.passengers passenger count
 * @param {number} info.timeInAirspace seconds the plane spent in the airspace
 * @param {number} [info.efficiencyBonus] optional explicit multiplier override;
 *   when provided it is used instead of the timeInAirspace-derived one.
 * @returns {number} revenue (whole dollars, >= 0)
 */
export function computeLandingRevenue({
  kind,
  passengers = 0,
  timeInAirspace = 0,
  efficiencyBonus,
} = {}) {
  const base = BASE_FEE[kind] ?? 100;
  const per = PER_PASSENGER[kind] ?? 10;
  const pax = Math.max(0, passengers);
  const efficiency =
    efficiencyBonus != null ? efficiencyBonus : efficiencyMultiplier(timeInAirspace);
  const revenue = (base + pax * per) * efficiency;
  return Math.max(0, Math.round(revenue));
}

/**
 * A minimal Bank model. Tracks a balance plus lifetime earned/spent totals.
 * Pure data + methods; no DOM. Used by the console display and (later) the
 * upgrade shop.
 */
export function createBank(startingBalance = 0) {
  return {
    balance: startingBalance,
    earned: 0,
    spent: 0,

    /** Add funds. Negative/invalid amounts are ignored. Returns new balance. */
    credit(amount) {
      if (!(amount > 0)) return this.balance;
      this.balance += amount;
      this.earned += amount;
      return this.balance;
    },

    /**
     * Remove funds if affordable. Returns true on success, false if the balance
     * is insufficient (balance unchanged in that case).
     */
    debit(amount) {
      if (!(amount > 0)) return false;
      if (amount > this.balance) return false;
      this.balance -= amount;
      this.spent += amount;
      return true;
    },

    /** Whether the balance covers a cost. */
    canAfford(cost) {
      return this.balance >= cost;
    },
  };
}
