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
 * Robustly derive the travel direction (radians) at the END of a drawn polyline.
 * A hand-drawn / touch path wobbles on its final segment, so taking atan2 of
 * only the last two points is noisy and can reject an otherwise-good approach.
 * Instead, walk back from the endpoint accumulating segments until we have
 * covered at least `tailLength` world-px (or run out of points), and return the
 * direction from that earlier anchor to the endpoint. This averages out the last
 * bit of jitter while still reflecting the final inbound course.
 *
 * Pure function. Falls back to the last-two-point heading for very short paths.
 * @param {Array<{x:number,y:number}>} points
 * @param {number} [tailLength] world-px of path tail to average over (default 32)
 * @returns {number} heading in radians (atan2 convention)
 */
export function approachHeadingFromPath(points, tailLength = 32) {
  if (!points || points.length < 2) return 0;
  const end = points[points.length - 1];
  // Walk backward until the straight-line distance from the anchor to the end
  // reaches tailLength, or we exhaust the path.
  let anchor = points[points.length - 2];
  for (let i = points.length - 2; i >= 0; i--) {
    anchor = points[i];
    if (Math.hypot(end.x - anchor.x, end.y - anchor.y) >= tailLength) break;
  }
  const dx = end.x - anchor.x;
  const dy = end.y - anchor.y;
  if (dx === 0 && dy === 0) {
    // Degenerate (anchor == end): fall back to the last distinct segment.
    const prev = points[points.length - 2];
    return Math.atan2(end.y - prev.y, end.x - prev.x);
  }
  return Math.atan2(dy, dx);
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

  // behind = distance on the inbound side of the threshold (positive). An
  // endpoint ON the runway has negative `behind` (it is past the threshold,
  // toward the far/stop end).
  const behind = -along;
  const coneLength = runway.approach.coneLength;
  // Accept an endpoint anywhere from well behind the threshold (deep in the
  // approach cone) THROUGH the far/stop end of the runway. "Draw the line to
  // the end of the runway" literally puts the endpoint at the far end, where
  // behind = -runway.length; the old window (behind >= -length*0.5) rejected
  // that. Allow a small margin (one runway width) past the far end so landing
  // right on the numbers / a hair beyond still counts.
  const farMargin = runway.width;
  const withinDepth = behind >= -(runway.length + farMargin) && behind <= coneLength;

  // Lateral half-width of the cone at this depth. Widen with the angular
  // tolerance deep in the cone, but keep a generous minimum half-width near the
  // strip so a slightly-off-centerline endpoint on a phone still snaps. The
  // minimum scales with runway width (2.5x) so wider strips stay forgiving too.
  const depthForWidth = Math.max(0, behind);
  const minHalfWidth = runway.width * 2.5;
  const halfWidth = Math.max(minHalfWidth, Math.tan(tol) * depthForWidth + runway.width);
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
  return d <= helipadCaptureRadius(helipad);
}

/**
 * Capture radius for a helipad (#2 fix). A route that ends on OR near the pad
 * should reliably land from ANY heading, so we use a generous band that scales
 * with the pad radius but never falls below a comfortable fixed px minimum
 * (small pads on a phone were effectively un-landable with the old radius*1.5).
 * Pure helper.
 */
export function helipadCaptureRadius(helipad) {
  const r = helipad.radius ?? 11;
  return Math.max(r * 3, 34);
}

/**
 * Forgiving runway CAPTURE used as a fallback when the strict isRunwayAligned
 * cone rejects an approach that a player clearly meant as a landing (ends short
 * of the cone mouth, just past the far end, or slightly off-axis in heading).
 *
 * For every runway and each of its two landing directions it measures how far
 * `endpoint` sits from the runway CENTERLINE SEGMENT (threshold..far) and from
 * the threshold, and whether the drawn `approachHeading` roughly matches that
 * landing direction. A direction captures when:
 *   - the lateral distance to the centerline is within a generous band
 *     (a comfortable multiple of runway.width, plus the cone allowance), AND
 *   - the endpoint is longitudinally within the strip plus a lead-in before the
 *     threshold and a margin past the far end, AND
 *   - the drawn heading is not reversed/perpendicular (within ~65deg of the
 *     landing direction — looser than the strict 28deg cone tol but still
 *     rejecting a crossing or backwards drag).
 *
 * Among the capturing candidates the one whose landing direction best matches
 * the drawn heading (then the closest) wins. When `opts.forcedRunwayId` is set
 * the capture is restricted to that runway id (a forced jet cannot capture a
 * different strip). Returns { type:'runway', surface, direction, detail } or
 * null. Pure function; never mutates the map.
 *
 * @param {object} map built map (runways[])
 * @param {{x:number,y:number}} endpoint drawn route endpoint
 * @param {number} approachHeading averaged tail heading (radians)
 * @param {object} def aircraft definition (runwayLengthRequired, usesRunway)
 * @param {{forcedRunwayId?:string}} [opts]
 */
export function captureRunway(map, endpoint, approachHeading, def, opts = {}) {
  if (!def.usesRunway || !map.runways || map.runways.length === 0) return null;
  const forcedRunwayId = opts.forcedRunwayId ?? null;
  // Widest heading error we will still treat as a landing attempt (not a
  // crossing/reverse). 65deg keeps a clearly-perpendicular (90deg) or reversed
  // (180deg) drag rejected while accepting the ~35-45deg off-axis cases.
  const MAX_HEADING_ERR = (65 * Math.PI) / 180;

  let best = null;
  for (const runway of map.runways) {
    if (forcedRunwayId && runway.id !== forcedRunwayId) continue;
    if (runway.length < def.runwayLengthRequired) continue;

    for (const dir of [runway.heading, normalizeAngle(runway.heading + Math.PI)]) {
      const headErr = angleDifference(approachHeading, dir);
      if (headErr > MAX_HEADING_ERR) continue;

      const virtual = { ...runway, heading: dir };
      const thr = runwayThreshold(virtual);
      const far = runwayFarEnd(virtual);

      // Decompose the endpoint relative to the threshold along/against the
      // landing direction (same basis as isRunwayAligned).
      const dx = endpoint.x - thr.x;
      const dy = endpoint.y - thr.y;
      const along = dx * Math.cos(dir) + dy * Math.sin(dir); // + = toward far end
      const lateral = -dx * Math.sin(dir) + dy * Math.cos(dir);

      // Lateral capture band: a comfortable multiple of the runway width plus
      // the approach cone allowance, so a slightly-off-centerline endpoint
      // snaps while a far-off (120px) one does not.
      const latBand = runway.width * 4 + 16;
      if (Math.abs(lateral) > latBand) continue;

      // Longitudinal window: from a lead-in BEFORE the threshold (so a short
      // drag that stops ahead of the cone mouth still captures) through the far
      // end plus a margin (so a drag that overshoots the far end captures too).
      const leadIn = runway.approach.coneLength + runway.length; // generous before-threshold reach
      const farMargin = runway.width * 2;
      if (along < -leadIn || along > runway.length + farMargin) continue;

      // Distance from the endpoint to the centerline SEGMENT (for scoring).
      const alongClamped = Math.max(0, Math.min(runway.length, along));
      const segX = thr.x + Math.cos(dir) * alongClamped;
      const segY = thr.y + Math.sin(dir) * alongClamped;
      const segDist = Math.hypot(endpoint.x - segX, endpoint.y - segY);

      // Score: prefer the direction whose heading matches best, then closest.
      const score = headErr * 120 + segDist;
      if (!best || score < best.score) {
        best = {
          type: "runway",
          surface: runway,
          direction: dir,
          detail: { distance: Math.hypot(dx, dy), segDist, headErr, capture: true },
          score,
        };
      }
    }
  }
  if (best) {
    const { score, ...rest } = best;
    return rest;
  }
  return null;
}

/**
 * Derive a sensible pair of opposite end labels from a runway id. A runway id
 * commonly encodes both landing ends (e.g. '09/27', '13/31', '10/28'): the
 * heading-0 end is the first token and the heading-PI (reciprocal) end is the
 * second. For a single-token id ('36L','RW1','CVN') we attempt to compute the
 * reciprocal of a two-digit magnetic-heading id ('36L' -> '18R', flipping the
 * L/R side) and otherwise fall back to the id itself for both ends. Pure.
 *
 * Returns { near, far } where `near` is the label for the runway.heading end
 * and `far` is the label for the reciprocal (runway.heading + PI) end.
 * @param {string} id
 * @returns {{near:string, far:string}}
 */
export function deriveEndLabels(id) {
  if (typeof id !== "string" || id.length === 0) {
    return { near: String(id ?? ""), far: String(id ?? "") };
  }
  // Explicit two-end form 'A/B'.
  if (id.includes("/")) {
    const [a, b] = id.split("/");
    return { near: a, far: b || a };
  }
  // Single magnetic-heading token like '36L' / '18R' (two digits + optional
  // side letter): compute the reciprocal heading (+/-18 in units of 10deg) and
  // swap the L/R side so the opposite end reads correctly.
  const m = id.match(/^(\d{1,2})([LRC]?)$/);
  if (m) {
    const num = parseInt(m[1], 10);
    if (num >= 1 && num <= 36) {
      let recip = num + 18;
      if (recip > 36) recip -= 36;
      const sideMap = { L: "R", R: "L", C: "C", "": "" };
      const recipSide = sideMap[m[2]] ?? m[2];
      const recipNum = String(recip).padStart(2, "0");
      return { near: id, far: recipNum + recipSide };
    }
  }
  // Non-heading id (e.g. 'RW1','CVN'): one stable label for both ends.
  return { near: id, far: id };
}

/**
 * The end label string for a given landing direction on a runway. `direction`
 * is a heading (radians). If it matches the runway's base heading the `near`
 * end label is returned; the reciprocal direction returns the `far` label.
 * Falls back to deriving labels from the id when a runway predates endLabels.
 * Pure function.
 * @param {object} runway
 * @param {number} direction landing heading (radians)
 * @returns {string}
 */
export function runwayEndLabel(runway, direction) {
  const labels = runway.endLabels || deriveEndLabels(runway.id);
  // Which end does `direction` correspond to? Compare against the base heading.
  const diff = angleDifference(direction, runway.heading);
  return diff <= Math.PI / 2 ? labels.near : labels.far;
}

/**
 * Create a runway with a mutable occupancy state. `clearTime` is how long (s)
 * the runway stays blocked after a landing.
 *
 * `endLabels` { near, far } are human-readable END names for the two landing
 * directions (the heading end and its reciprocal). They are DISPLAY labels; the
 * string `id` remains the stable physical-strip identifier (tests and
 * clearance.runwayId depend on the id, never on the labels). When omitted they
 * are derived from the id via deriveEndLabels.
 */
export function createRunway(opts) {
  return {
    id: opts.id,
    endLabels: opts.endLabels ?? deriveEndLabels(opts.id),
    x: opts.x,
    y: opts.y,
    heading: opts.heading,
    length: opts.length,
    // FEAT-004: default width/coneLength shrunk by 0.70 (14->10, 180->126) to
    // match the whole-airport scale-down. Tolerance (28deg) stays forgiving.
    width: opts.width ?? 10,
    approach: {
      tolerance: opts.approach?.tolerance ?? (28 * Math.PI) / 180,
      coneLength: opts.approach?.coneLength ?? 126,
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
    // FEAT-004: shrunk 0.70 (230->161, width 14->10, cone 200->140).
    length: 161,
    width: 10,
    approach: { tolerance: (28 * Math.PI) / 180, coneLength: 140 },
    clearTime: 3,
  });

  const runwayB = createRunway({
    id: "13/31",
    x: cx,
    y: cy,
    heading: (55 * Math.PI) / 180, // crosses runway A
    // FEAT-004: shrunk 0.70 (180->126, width 14->10, cone 180->126).
    length: 126,
    width: 10,
    approach: { tolerance: (28 * Math.PI) / 180, coneLength: 126 },
    clearTime: 3,
  });

  const helipad = {
    id: "H1",
    x: cx + 70,
    y: cy - 90,
    radius: 11, // FEAT-004: shrunk 0.70 (16 -> 11)
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
