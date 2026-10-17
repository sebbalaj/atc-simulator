// Airport geometry and the Map 1 ("Regional Airfield") definition. A runway has
// a center, a heading (the landing direction, radians, pointing the way an
// aircraft travels while rolling out), a length and width, and an approach cone
// (angular tolerance + cone length) extending back from the touchdown threshold
// against the landing direction. A helipad accepts any heading for helicopters.
//
// The alignment math is pure and exported so it can be unit-tested under Node.
// Runways also carry a mutable occupancy state (a plane blocks the runway for a
// clear time after landing).

import { AircraftKind } from "./aircraft.js";

const TWO_PI = Math.PI * 2;

/** Normalize an angle to (-PI, PI]. */
export function normalizeAngle(a) {
  let x = a % TWO_PI;
  if (x <= -Math.PI) x += TWO_PI;
  if (x > Math.PI) x -= TWO_PI;
  return x;
}

/** Smallest absolute difference between two headings (radians, >= 0). */
export function angleDifference(a, b) {
  return Math.abs(normalizeAngle(a - b));
}

/**
 * The world-space touchdown threshold of a runway: the point where an inbound
 * aircraft first meets the runway, i.e. the up-wind end relative to the landing
 * direction. Planes roll from here toward the far end.
 */
export function runwayThreshold(runway) {
  return {
    x: runway.x - Math.cos(runway.heading) * (runway.length / 2),
    y: runway.y - Math.sin(runway.heading) * (runway.length / 2),
  };
}

/** The far (stop) end of the runway in the landing direction. */
export function runwayFarEnd(runway) {
  return {
    x: runway.x + Math.cos(runway.heading) * (runway.length / 2),
    y: runway.y + Math.sin(runway.heading) * (runway.length / 2),
  };
}

/**
 * Decide whether an approach is aligned with a runway and legal for the given
 * aircraft class. An approach is defined by the point where the drawn path
 * terminates (`endpoint`) and the direction the aircraft is traveling there
 * (`approachHeading`, radians).
 *
 * Acceptance requires all of:
 *   - the runway is long enough for the class (runwayLengthRequired),
 *   - the travel direction matches the runway landing direction within the
 *     cone's angular tolerance,
 *   - the endpoint lies inside the approach cone: behind the threshold (on the
 *     inbound side) and within coneLength, with lateral offset inside the cone.
 *
 * Helicopters landing on a helipad bypass this (any heading): see isHelipadLanding.
 *
 * Pure function. Returns a detail object so callers/tests can inspect reasons.
 * @returns {{aligned:boolean, headingOk:boolean, lengthOk:boolean, inCone:boolean, distance:number}}
 */
export function isRunwayAligned(runway, endpoint, approachHeading, aircraftDef) {
  const lengthOk = runway.length >= aircraftDef.runwayLengthRequired;

  const tol = runway.approach.tolerance;
  const headingOk = angleDifference(approachHeading, runway.heading) <= tol;

  // Vector from the threshold to the endpoint, decomposed along/against the
  // landing direction. The cone opens backward from the threshold (negative
  // along-track) toward inbound traffic.
  const thr = runwayThreshold(runway);
  const dx = endpoint.x - thr.x;
  const dy = endpoint.y - thr.y;
  const along = dx * Math.cos(runway.heading) + dy * Math.sin(runway.heading);
  const lateral = -dx * Math.sin(runway.heading) + dy * Math.cos(runway.heading);

  // behind = distance on the inbound side of the threshold (positive).
  const behind = -along;
  const coneLength = runway.approach.coneLength;
  // Allow a small overrun past the threshold so a plane that has just reached
  // the numbers still counts as landing.
  const withinDepth = behind >= -runway.length * 0.5 && behind <= coneLength;

  // Lateral half-width of the cone at this depth (widens with tolerance).
  const depthForWidth = Math.max(0, behind);
  const halfWidth = Math.max(runway.width, Math.tan(tol) * depthForWidth + runway.width);
  const inCone = withinDepth && Math.abs(lateral) <= halfWidth;

  const distance = Math.hypot(dx, dy);
  const aligned = lengthOk && headingOk && inCone;
  return { aligned, headingOk, lengthOk, inCone, distance };
}

/**
 * Whether a helicopter can land on a helipad: it just has to reach the pad
 * (endpoint within pad radius). Heading is unrestricted. Pure function.
 */
export function isHelipadLanding(helipad, endpoint, aircraftDef) {
  if (!aircraftDef.landsOnHelipad) return false;
  const d = Math.hypot(endpoint.x - helipad.x, endpoint.y - helipad.y);
  return d <= helipad.radius * 1.5;
}

/**
 * Create a runway with a mutable occupancy state. `clearTime` is how long (s)
 * the runway stays blocked after a landing.
 */
export function createRunway(opts) {
  return {
    id: opts.id,
    x: opts.x,
    y: opts.y,
    heading: opts.heading,
    length: opts.length,
    width: opts.width ?? 14,
    approach: {
      tolerance: opts.approach?.tolerance ?? (16 * Math.PI) / 180,
      coneLength: opts.approach?.coneLength ?? 180,
    },
    clearTime: opts.clearTime ?? 3,
    // Mutable state.
    occupiedUntil: 0, // simulation time (s) until which the runway is blocked
  };
}

/** Whether a runway is currently clear to accept a landing at sim time `now`. */
export function isRunwayClear(runway, now) {
  return now >= runway.occupiedUntil;
}

/** Mark a runway occupied starting now; it clears after `clearTime`. */
export function occupyRunway(runway, now) {
  runway.occupiedUntil = now + runway.clearTime;
}

/**
 * Build the Map 1 airport: two intersecting runways plus a helipad, centered on
 * the given radar dimensions. Headings are chosen so the two runways cross.
 */
export function createMap1(width, height) {
  const cx = width / 2;
  const cy = height / 2;

  const runwayA = createRunway({
    id: "09/27",
    x: cx,
    y: cy,
    heading: 0, // landing toward +x (east)
    length: 230,
    width: 14,
    approach: { tolerance: (16 * Math.PI) / 180, coneLength: 200 },
    clearTime: 3,
  });

  const runwayB = createRunway({
    id: "13/31",
    x: cx,
    y: cy,
    heading: (55 * Math.PI) / 180, // crosses runway A
    length: 180,
    width: 14,
    approach: { tolerance: (16 * Math.PI) / 180, coneLength: 180 },
    clearTime: 3,
  });

  const helipad = {
    id: "H1",
    x: cx + 70,
    y: cy - 90,
    radius: 16,
  };

  // Hospital POI: medical-evac helicopters must be routed directly over this
  // point before their landing on the helipad is accepted. Placed away from the
  // field so it forces a deliberate detour.
  const hospital = {
    id: "HOSP",
    x: cx - width * 0.28,
    y: cy + height * 0.26,
    radius: 22, // a route passing within this radius "overflies" the hospital
  };

  // A holding fix: when the controller routes a plane here (without a landing
  // clearance) it flies a circular orbit, burning fuel over time. Used by the
  // fuel-emergency logic.
  const holdFix = {
    id: "HOLD1",
    x: cx + width * 0.3,
    y: cy + height * 0.28,
    radius: 34, // orbit radius
  };

  return {
    id: "map1",
    name: "Regional Airfield",
    width,
    height,
    center: { x: cx, y: cy },
    runways: [runwayA, runwayB],
    helipad,
    // FEAT-005: all pads as a list (helipad stays the primary for back-compat).
    helipads: [helipad],
    airports: [{ id: "RGL", name: "Regional", x: cx, y: cy, size: "medium" }],
    hospital,
    holdFix,
    // Aircraft enter from this perimeter radius around the center.
    spawnRadius: Math.min(width, height) * 0.52,
    // FEAT-005: map-specific rules (wake strictness, spawn scaling, hint).
    rules: { wakeMultiplier: 1, spawnScale: 1, routingHint: "Two intersecting runways." },
  };
}

/**
 * Whether a point overflies the hospital POI (within its radius). Pure function.
 */
export function isOverHospital(hospital, x, y) {
  if (!hospital) return false;
  return Math.hypot(x - hospital.x, y - hospital.y) <= hospital.radius;
}

/**
 * Whether any point of a drawn polyline route passes over the hospital POI.
 * Used by the medical-evac gate so the controller can satisfy the requirement
 * by drawing a path that crosses the hospital on the way to the pad. Pure.
 */
export function routePassesHospital(hospital, points) {
  if (!hospital || !points || points.length === 0) return false;
  for (const p of points) {
    if (isOverHospital(hospital, p.x, p.y)) return true;
  }
  return false;
}

/**
 * Build a circular holding-pattern orbit (a closed polyline) centered on a hold
 * fix. A plane routed here with no landing clearance flies the loop and burns
 * fuel. Pure function returning control points suitable for buildPath.
 * @param {{x:number,y:number,radius:number}} fix
 * @param {number} [segments] number of points around the circle
 */
export function holdingPatternPoints(fix, segments = 12) {
  const pts = [];
  const r = fix.radius ?? 34;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push({ x: fix.x + Math.cos(a) * r, y: fix.y + Math.sin(a) * r });
  }
  return pts;
}

/**
 * Resolve a landing target for a path endpoint + approach heading. Returns the
 * best matching runway (or the helipad) and the match detail, or null if the
 * endpoint does not line up with any valid landing surface. Pure function.
 */
export function findLandingTarget(map, endpoint, approachHeading, aircraftDef) {
  // Helicopters: prefer the helipad.
  if (aircraftDef.landsOnHelipad && map.helipad) {
    if (isHelipadLanding(map.helipad, endpoint, aircraftDef)) {
      return { type: "helipad", surface: map.helipad };
    }
  }

  if (aircraftDef.usesRunway) {
    let best = null;
    for (const runway of map.runways) {
      // A runway is bidirectional: test both landing directions.
      for (const dir of [runway.heading, runway.heading + Math.PI]) {
        const virtual = dir === runway.heading
          ? runway
          : { ...runway, heading: normalizeAngle(dir) };
        const detail = isRunwayAligned(virtual, endpoint, approachHeading, aircraftDef);
        if (detail.aligned) {
          if (!best || detail.distance < best.detail.distance) {
            best = { type: "runway", surface: runway, direction: normalizeAngle(dir), detail };
          }
        }
      }
    }
    if (best) return best;
  }

  return null;
}

export { AircraftKind };
