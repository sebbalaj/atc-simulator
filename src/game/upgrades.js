// Upgrades: pure, DOM-free catalog + application logic for the between-shift /
// live upgrade shop. Each catalog entry has an id, category, label, cost and a
// short description. applyUpgrade(state, id) mutates a plain game-config/state
// object (the active map plus a few flags); purchase(state, bank, id) integrates
// with the economy Bank (canAfford + debit) before applying the effect.
//
// The "state" shape applyUpgrade mutates:
//   {
//     map:   the active map definition (runways[], helipad/helipads[],
//            spawnRadius, rules, ...). Mutated in place so the running game sees
//            the change immediately.
//     flags: { ilsOwned, holdingAutomation, groundCrew, radarLevel, ... } a bag
//            of booleans/counters the systems read (e.g. game reads flags.ilsOwned
//            via game.ilsOwned). May be omitted; it is created on demand.
//     owned: Set/array of purchased one-shot upgrade ids (so they cannot be
//            bought twice). Created on demand.
//   }
//
// Everything here is unit-testable under Node (no DOM).

import { createRunway } from "./airport.js";
import { AIRCRAFT_DEFS, AircraftKind } from "./aircraft.js";

/** How much the radar range (spawn perimeter) grows per RADAR RANGE purchase. */
export const RADAR_RANGE_STEP = 60;
/** How much a runway is lengthened per RUNWAY LENGTHEN purchase (px). */
export const RUNWAY_LENGTHEN_STEP = 70;
/** Fraction by which ground crew reduce runway clear-time per STAFFING buy. */
export const CLEAR_TIME_REDUCTION = 0.3;
/** New runway length when INFRASTRUCTURE builds one (accepts jets). */
export const NEW_RUNWAY_LENGTH = 220;

/** Minimum runway length that accepts a COMMERCIAL jet (from the class table). */
export const COMMERCIAL_RUNWAY_LENGTH = AIRCRAFT_DEFS[AircraftKind.COMMERCIAL].runwayLengthRequired;

/**
 * The upgrade catalog. `repeatable` upgrades can be bought multiple times
 * (each application costs the listed amount); non-repeatable (one-shot)
 * upgrades can be purchased once and are tracked in state.owned.
 */
export const UPGRADES = Object.freeze([
  {
    id: "radar-range",
    category: "Radar Range",
    label: "Extend Radar Range",
    description: "Expand the spawn perimeter to see incoming traffic earlier.",
    cost: 1500,
    repeatable: true,
  },
  {
    id: "build-runway",
    category: "Infrastructure",
    label: "Build New Runway",
    description: "Add a runway long enough to accept heavy jets.",
    cost: 4000,
    repeatable: true,
  },
  {
    id: "lengthen-runway",
    category: "Infrastructure",
    label: "Lengthen Runway",
    description: "Extend the shortest runway so it can accept COMMERCIAL jets.",
    cost: 2500,
    repeatable: true,
  },
  {
    id: "build-helipad",
    category: "Infrastructure",
    label: "Build Helipad",
    description: "Construct a helipad for rotary-wing traffic.",
    cost: 1800,
    repeatable: true,
  },
  {
    id: "ils",
    category: "Technology",
    label: "Install ILS",
    description: "Allow landings during low visibility / fog.",
    cost: 3000,
    repeatable: false,
  },
  {
    id: "auto-holding",
    category: "Technology",
    label: "Automated Holding Patterns",
    description: "Hold fixes auto-manage orbits, easing congestion.",
    cost: 2200,
    repeatable: false,
  },
  {
    id: "ground-crew",
    category: "Staffing",
    label: "Hire Ground Crew",
    description: "Reduce runway clearing time after each landing.",
    cost: 1200,
    repeatable: true,
  },
]);

/** Look up a catalog entry by id. Returns null for unknown ids. */
export function getUpgrade(id) {
  return UPGRADES.find((u) => u.id === id) || null;
}

/** Ensure the flags/owned containers exist on a state object. */
function ensureContainers(state) {
  if (!state.flags) state.flags = {};
  if (!state.owned) state.owned = [];
  if (state.flags.radarLevel == null) state.flags.radarLevel = 0;
  if (state.flags.groundCrew == null) state.flags.groundCrew = 0;
  return state;
}

/** Whether a one-shot upgrade has already been purchased. */
export function isOwned(state, id) {
  return !!(state && state.owned && state.owned.includes(id));
}

/**
 * Apply an upgrade's effect to the state (mutating the active map + flags).
 * Pure with respect to money (callers debit the bank separately via purchase()).
 * Returns { ok, reason } — ok=false when the upgrade cannot apply (unknown id,
 * already owned, nothing to act on).
 * @param {object} state { map, flags?, owned? }
 * @param {string} id catalog id
 */
export function applyUpgrade(state, id) {
  const def = getUpgrade(id);
  if (!def) return { ok: false, reason: "unknown" };
  ensureContainers(state);
  if (!def.repeatable && isOwned(state, id)) {
    return { ok: false, reason: "already-owned" };
  }
  const map = state.map;

  switch (id) {
    case "radar-range": {
      if (!map) return { ok: false, reason: "no-map" };
      map.spawnRadius = (map.spawnRadius ?? 0) + RADAR_RANGE_STEP;
      state.flags.radarLevel += 1;
      break;
    }
    case "build-runway": {
      if (!map) return { ok: false, reason: "no-map" };
      const n = map.runways.length + 1;
      const runway = createRunway({
        id: "NEW" + n,
        x: map.center.x,
        y: map.center.y + (n % 2 === 0 ? 60 : -60),
        heading: (30 * Math.PI) / 180,
        length: NEW_RUNWAY_LENGTH,
        width: 14,
        approach: { tolerance: (15 * Math.PI) / 180, coneLength: 190 },
        clearTime: 3,
      });
      map.runways.push(runway);
      break;
    }
    case "lengthen-runway": {
      if (!map || map.runways.length === 0) return { ok: false, reason: "no-runway" };
      // Lengthen the shortest runway, and guarantee it clears the COMMERCIAL
      // threshold so a heavy jet can use it after the upgrade.
      let shortest = map.runways[0];
      for (const r of map.runways) {
        if (r.length < shortest.length) shortest = r;
      }
      const extended = shortest.length + RUNWAY_LENGTHEN_STEP;
      shortest.length = Math.max(extended, COMMERCIAL_RUNWAY_LENGTH);
      break;
    }
    case "build-helipad": {
      if (!map) return { ok: false, reason: "no-map" };
      if (!map.helipads) map.helipads = map.helipad ? [map.helipad] : [];
      const n = map.helipads.length + 1;
      const pad = {
        id: "H" + n,
        x: map.center.x - 80 + n * 20,
        y: map.center.y - 110,
        radius: 15,
      };
      map.helipads.push(pad);
      if (!map.helipad) map.helipad = pad;
      break;
    }
    case "ils": {
      state.flags.ilsOwned = true;
      break;
    }
    case "auto-holding": {
      state.flags.holdingAutomation = true;
      break;
    }
    case "ground-crew": {
      state.flags.groundCrew += 1;
      // Reduce clear-time on every runway (down to a small floor).
      if (map && map.runways) {
        for (const r of map.runways) {
          r.clearTime = Math.max(0.8, (r.clearTime ?? 3) * (1 - CLEAR_TIME_REDUCTION));
        }
      }
      break;
    }
    default:
      return { ok: false, reason: "unknown" };
  }

  if (!def.repeatable) state.owned.push(id);
  return { ok: true };
}

/**
 * Purchase an upgrade: check the Bank can afford it, debit, then apply. Returns
 * { ok, reason }. On insufficient funds returns { ok:false, reason:'insufficient-funds' }
 * and does not touch the state. On an un-appliable upgrade the debit is refunded.
 * @param {object} state { map, flags?, owned? }
 * @param {object} bank economy Bank (canAfford/debit/credit)
 * @param {string} id catalog id
 */
export function purchase(state, bank, id) {
  const def = getUpgrade(id);
  if (!def) return { ok: false, reason: "unknown" };
  ensureContainers(state);
  if (!def.repeatable && isOwned(state, id)) {
    return { ok: false, reason: "already-owned" };
  }
  if (!bank || !bank.canAfford(def.cost)) {
    return { ok: false, reason: "insufficient-funds" };
  }
  // Debit first so applyUpgrade's own-check is authoritative; refund on failure.
  if (!bank.debit(def.cost)) {
    return { ok: false, reason: "insufficient-funds" };
  }
  const res = applyUpgrade(state, id);
  if (!res.ok) {
    bank.credit(def.cost); // refund
    return res;
  }
  return { ok: true, cost: def.cost };
}
