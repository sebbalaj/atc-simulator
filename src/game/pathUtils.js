// Pure geometry helpers for flight-path validation and traversal, factored out
// so the simulation math is unit-testable under Node without any DOM. Used by
// the movement system and the input snap logic.

import { buildPath, pointAtDistance } from "../core/spline.js";
import { normalizeAngle } from "./airport.js";

/**
 * The turn angle (radians, >= 0) at an interior control point: how sharply the
 * path bends when going from the incoming segment to the outgoing segment. A
 * straight line has turn angle 0; a full reversal approaches PI.
 */
export function turnAngleAt(prev, pt, next) {
  const inHeading = Math.atan2(pt.y - prev.y, pt.x - prev.x);
  const outHeading = Math.atan2(next.y - pt.y, next.x - pt.x);
  return Math.abs(normalizeAngle(outHeading - inHeading));
}

/**
 * Validate a list of control points against a class's maximum per-point turn
 * angle. Returns {ok, worstAngle, worstIndex}. Degenerate (zero-length)
 * segments are skipped. Pure function.
 * @param {{x:number,y:number}[]} points
 * @param {number} maxTurnAngle radians
 */
export function validateTurns(points, maxTurnAngle) {
  let worstAngle = 0;
  let worstIndex = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const pt = points[i];
    const next = points[i + 1];
    if (
      (prev.x === pt.x && prev.y === pt.y) ||
      (next.x === pt.x && next.y === pt.y)
    ) {
      continue;
    }
    const a = turnAngleAt(prev, pt, next);
    if (a > worstAngle) {
      worstAngle = a;
      worstIndex = i;
    }
  }
  return { ok: worstAngle <= maxTurnAngle, worstAngle, worstIndex };
}

/**
 * Clamp a raw list of drawn control points so no corner exceeds the class turn
 * limit. Points that would create an over-sharp corner are dropped. The first
 * and last points are always kept. Pure function. Returns a new array.
 */
export function clampTurns(points, maxTurnAngle) {
  if (points.length <= 2) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    const pt = points[i];
    const next = points[i + 1];
    const a = turnAngleAt(prev, pt, next);
    if (a <= maxTurnAngle) out.push(pt);
    // else: skip this point, smoothing the corner.
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Advance along a built path by a distance and report position + heading.
 * Heading is derived from a short look-ahead so the icon faces travel direction.
 * Pure function.
 * @param {object} built result of buildPath
 * @param {number} dist arc length from the start
 */
export function sampleAlong(built, dist) {
  const pos = pointAtDistance(built, dist);
  const ahead = pointAtDistance(built, Math.min(built.length, dist + 2));
  let heading;
  if (ahead.x === pos.x && ahead.y === pos.y) {
    const behind = pointAtDistance(built, Math.max(0, dist - 2));
    heading = Math.atan2(pos.y - behind.y, pos.x - behind.x);
  } else {
    heading = Math.atan2(ahead.y - pos.y, ahead.x - pos.x);
  }
  return { x: pos.x, y: pos.y, heading };
}

export { buildPath, pointAtDistance };
