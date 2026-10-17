// Emergencies: pure, DOM-free decision logic for the three emergency types.
// Rendering (the red flash, the fuel gauge, the hospital POI marker) lives in
// the HUD/render system; the gameplay rules that decide WHEN an emergency is
// active, how it modulates a plane's behaviour, and whether a landing is
// allowed are all here so they are unit-testable under Node.
//
//   MAYDAY / ENGINE FAILURE - a plane flagged as mayday moves faster (a speed
//     multiplier), descends, red-flashes, and demands an immediate straight-line
//     priority route to the nearest runway. maydaySpeedFactor() gives the speed
//     bump; markMayday() stamps the emergency onto an Aircraft component.
//   FUEL EMERGENCY - a plane held in a holding pattern too long burns down to a
//     low-fuel state and crashes at empty. isFuelEmergency() tests the fuel
//     fraction against the emergency threshold; the drain itself is fuel.js.
//   MEDICAL EVAC - a helicopter that must overfly the hospital POI before its
//     landing is accepted. isMedicalLandingAllowed() gates the landing on the
//     hospital-visited flag.

import { fuelStatus } from "./fuel.js";

/** Canonical emergency type constants. */
export const EmergencyType = Object.freeze({
  MAYDAY: "mayday",
  FUEL: "fuel",
  MEDICAL: "medical",
});

/** Speed multiplier applied to a mayday (engine-failure) aircraft. */
export const MAYDAY_SPEED_FACTOR = 1.45;

/** Fuel fraction at/under which a held plane is in a fuel emergency. */
export const FUEL_EMERGENCY_FRACTION = 0.25;

/** Default probabilities / tuning for the emergency controller. */
export const EMERGENCY_DEFAULTS = Object.freeze({
  maydayChance: 0.08, // chance a given spawn becomes a mayday
  medicalChance: 0.5, // chance a helicopter spawn is a medical evac
  bonusReputation: 5, // reputation awarded for safely handling an emergency
});

/**
 * The effective speed factor for an aircraft given its emergency state. A
 * mayday plane flies faster; everyone else is unchanged. Pure function.
 * @param {object|null} emergency the Aircraft.emergency object (or null)
 * @param {number} [base] a base speed factor to multiply (default 1)
 */
export function maydaySpeedFactor(emergency, base = 1) {
  if (emergency && emergency.type === EmergencyType.MAYDAY) {
    return base * MAYDAY_SPEED_FACTOR;
  }
  return base;
}

/** Whether an aircraft is flagged as a mayday priority. Pure function. */
export function isMaydayPriority(emergency) {
  return !!(emergency && emergency.type === EmergencyType.MAYDAY);
}

/**
 * Pick the nearest runway that is long enough to accept the given aircraft
 * class, measured from the aircraft's current position to each runway center.
 * A mayday gets an IMMEDIATE straight-line priority clearance to this runway
 * (see straightLineApproach below). Returns the runway object or null when no
 * runway on the map is adequate. Pure function (no DOM, no mutation).
 *
 * @param {Array} runways map.runways
 * @param {{x:number,y:number}} pos aircraft position
 * @param {object} aircraftDef class def (needs runwayLengthRequired)
 */
export function nearestAdequateRunway(runways, pos, aircraftDef) {
  if (!runways || runways.length === 0) return null;
  const need = aircraftDef ? aircraftDef.runwayLengthRequired ?? 0 : 0;
  let best = null;
  let bestDist = Infinity;
  for (const r of runways) {
    if (r.length < need) continue;
    const d = Math.hypot(pos.x - r.x, pos.y - r.y);
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best;
}

/**
 * Build a straight-line priority approach for a mayday: a two-point route from
 * the aircraft's current position to the chosen runway's threshold, with the
 * landing direction and far-end chosen to be the runway end that lets the plane
 * continue roughly forward (least heading change). Returns
 *   { points:[start, threshold], clearance:{surface, runwayId, heading, threshold, stop} }
 * so the landing system can commit it exactly like a hand-drawn clearance.
 * Pure function; `geom` injects the runway-geometry helpers so this module stays
 * free of an airport.js import cycle.
 *
 * @param {{x:number,y:number}} pos aircraft position
 * @param {object} runway chosen runway
 * @param {object} geom { threshold(r), farEnd(r), normalizeAngle(a) }
 */
export function straightLineApproach(pos, runway, geom) {
  // Consider both landing directions; pick the one whose threshold is closest to
  // the aircraft so the straight-in is as short (and forward) as possible.
  const dirs = [runway.heading, geom.normalizeAngle(runway.heading + Math.PI)];
  let best = null;
  for (const heading of dirs) {
    const dirRunway = { ...runway, heading };
    const thr = geom.threshold(dirRunway);
    const far = geom.farEnd(dirRunway);
    const d = Math.hypot(pos.x - thr.x, pos.y - thr.y);
    if (!best || d < best.d) {
      best = { heading, thr, far, d };
    }
  }
  return {
    points: [
      { x: pos.x, y: pos.y },
      { x: best.thr.x, y: best.thr.y },
    ],
    clearance: {
      surface: "runway",
      runwayId: runway.id,
      heading: best.heading,
      threshold: { x: best.thr.x, y: best.thr.y },
      stop: { x: best.far.x, y: best.far.y },
      priority: true,
    },
  };
}

/**
 * Stamp a mayday/engine-failure emergency onto an Aircraft component. Marks it
 * priority and records the descent rate so the HUD can show a diving target.
 * Mutates and returns the aircraft. Pure (no DOM).
 */
export function markMayday(ac) {
  ac.emergency = {
    type: EmergencyType.MAYDAY,
    priority: true,
    speedFactor: MAYDAY_SPEED_FACTOR,
    descending: true,
    descentRate: 1, // relative: used by the HUD label only
  };
  // Keep the stamped factor on the emergency object only. The movement system
  // derives the effective speed from the emergency via maydaySpeedFactor(), so
  // there is a single source of truth (no separately-stamped ac.speedFactor to
  // drift or double-apply). ac.speedFactor stays at its base (1) for maydays.
  return ac.emergency;
}

/**
 * Stamp a medical-evacuation emergency onto a (helicopter) Aircraft component.
 * The landing is gated until `hospitalVisited` is set true. Mutates/returns.
 */
export function markMedical(ac) {
  ac.emergency = {
    type: EmergencyType.MEDICAL,
    priority: false,
    hospitalVisited: false,
  };
  return ac.emergency;
}

/** Stamp a fuel emergency onto an Aircraft component. Mutates/returns. */
export function markFuelEmergency(ac) {
  ac.emergency = {
    type: EmergencyType.FUEL,
    priority: true,
  };
  return ac.emergency;
}

/**
 * Whether a plane's fuel has fallen into the emergency band. Pure function over
 * a Fuel component. Used to flag the visible gauge + reputation stakes.
 * @param {object} fuel Fuel component {capacity, remaining}
 * @param {number} [threshold] fraction (default FUEL_EMERGENCY_FRACTION)
 */
export function isFuelEmergency(fuel, threshold = FUEL_EMERGENCY_FRACTION) {
  if (!fuel) return false;
  const st = fuelStatus(fuel);
  return st.fraction <= threshold;
}

/**
 * Whether a medical-evac landing is currently allowed. The helicopter must have
 * overflown the hospital POI first (recorded on the emergency as
 * `hospitalVisited`). Non-medical aircraft are unaffected (always allowed).
 * Pure function.
 * @param {object|null} emergency the Aircraft.emergency object
 * @returns {boolean}
 */
export function isMedicalLandingAllowed(emergency) {
  if (!emergency || emergency.type !== EmergencyType.MEDICAL) return true;
  return emergency.hospitalVisited === true;
}

/**
 * Create an EmergencyController: decides which spawns become emergencies and
 * holds the tuning. Uses the seeded RNG so a shift is reproducible. DOM-free.
 * @param {object} opts { rng, config? }
 */
export function createEmergencyController(opts = {}) {
  const rng = opts.rng;
  const cfg = { ...EMERGENCY_DEFAULTS, ...(opts.config || {}) };

  /**
   * Given a freshly spawned aircraft, decide whether it should be flagged as an
   * emergency and stamp it. Returns the emergency object or null. Helicopters
   * may become medical evacs; other classes may become maydays.
   * @param {object} ac Aircraft component
   * @param {boolean} isHelicopter
   */
  function classifySpawn(ac, isHelicopter) {
    const roll = rng ? rng.next() : 1;
    if (isHelicopter) {
      if (roll < cfg.medicalChance) return markMedical(ac);
      return null;
    }
    if (roll < cfg.maydayChance) return markMayday(ac);
    return null;
  }

  return { config: cfg, classifySpawn };
}
